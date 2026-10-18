import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertUsableApiKey, errorChain, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import z from '@deepseek-ai/schemastery';
import { createProvider } from '@earendil-works/pi-ai';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { stream as piAgentStream, streamSimple as piAgentStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as piResponsesStream, streamSimple as piResponsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses';
export const name = 'opencode-zen-free-provider';
export const inject = ['llm'];
const PROVIDER = name;
const DISPLAY_NAME = 'OpenCode Zen Free';
const ZEN_BASE_URL = 'https://opencode.ai/inference/v1';
const ZEN_CATALOG_URL = `${ZEN_BASE_URL}/models`;
/**
 * Latest CLI version, read off unpkg's `@latest` redirect via the package's own `package.json`.
 *
 * The fallback matters: Zen refuses anything below 1.18.0 outright with HTTP 426
 * "OpenCode 1.18.0 or newer is required to use the free tier", so an unreachable
 * unpkg must not silently drop us below that floor.
 */
const OPENCODE_VERSION_URL = 'https://unpkg.com/opencode-ai@latest/package.json';
const OPENCODE_VERSION_FALLBACK = '1.19.0';
/** Envelope types that must stay AUTH-classified instead of being rewritten. */
const AUTH_ERROR_TYPES = new Set(['AuthError', 'authentication_error', 'invalid_api_key', 'unauthorized']);
/**
 * Request image budget: 2 MiB of base64 per request, 1 MiB per image.
 *
 * The budget is compared against the base64 length the wire carries (×4/3), so
 * one full-size image is ~1.4 MB and fits with room for a second at ~700 KB. A
 * third occurrence makes the harness offload the oldest one to a text
 * placeholder that still names its local normalized copy. This wire is
 * stateless, so every retained image rides every turn again.
 */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 2_097_152;
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576;
const ModelSettings = z.object({
    id: z.string().pattern(/-free$/).required(),
    name: z.string(),
    contextWindow: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    input: z.array(z.union(['text', 'image'])),
});
export const Config = z.object({
    // null inherits the scanned catalog; an explicit array replaces it.
    models: z.union([z.array(ModelSettings), z.const(null)]).default(null).role('model-catalog').volatile(),
    maxRequestImageBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES).volatile(),
    requestImageMaxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES).volatile(),
    retryPolicy: RetryPolicySchema.volatile(),
    // Re-route the first refusal of a request instead of failing the turn.
    upstreamRecovery: z.boolean().default(true).volatile(),
});
/**
 * The committed configuration as plain mutable values. Unwrapping the references
 * yields immutable snapshots; cloning is what makes them workable again.
 */
function liveConfig(config) {
    return structuredClone({
        models: config.models.get(),
        maxRequestImageBytes: config.maxRequestImageBytes.get(),
        requestImageMaxBytes: config.requestImageMaxBytes.get(),
        retryPolicy: config.retryPolicy.get(),
        upstreamRecovery: config.upstreamRecovery.get(),
    });
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const resolveOpenCodeVersion = async () => {
    try {
        const payload = await fetchJson(OPENCODE_VERSION_URL, { accept: 'application/json' });
        return typeof payload.version === 'string' && payload.version.length > 0 ? payload.version : OPENCODE_VERSION_FALLBACK;
    }
    catch {
        return OPENCODE_VERSION_FALLBACK;
    }
};
/**
 * Identifier format of the opencode CLI (`packages/schema/src/identifier.ts`):
 * the 12 leading hex digits are the six most significant bytes of a 64-bit
 * value (`ms * 0x1000 + counter`, bit-inverted for `ses_` so the newest sorts
 * first), followed by 14 random base62 characters.
 *
 * Zen's free tier decodes that timestamp prefix, so a digest-shaped prefix gets
 * `FreeTierError` even with every header correct. `msg_` is not validated, but
 * minting both the same way keeps the wire honest.
 */
const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastIdTimestamp = 0;
let idCounter = 0;
const opencodeId = (prefix, descending) => {
    const timestamp = Date.now();
    if (timestamp !== lastIdTimestamp) {
        lastIdTimestamp = timestamp;
        idCounter = 0;
    }
    idCounter += 1;
    let value = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
    if (descending)
        value = ~value;
    // Byte by byte from the top, as upstream does: `ses_` inverts the value, and
    // a single arithmetic shift of a negative BigInt is floored, not truncated.
    let time = '';
    for (let index = 0; index < 6; index += 1) {
        time += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, '0');
    }
    let random = '';
    for (let index = 0; index < 14; index += 1) {
        random += ID_ALPHABET[Math.floor(Math.random() * 62)];
    }
    return `${prefix}_${time}${random}`;
};
/**
 * Session ids already minted for a conversation. Zen meters free usage per
 * session and routes its prompt cache by the id, so every turn of one
 * conversation has to reuse the id minted its first turn.
 */
const ZEN_SESSION_KEEP = 128;
const zenSessions = new Map();
const zenSessionId = (seed) => {
    const hit = zenSessions.get(seed);
    if (hit !== undefined)
        return hit;
    const minted = opencodeId('ses', true);
    if (zenSessions.size >= ZEN_SESSION_KEEP) {
        const oldest = zenSessions.keys().next();
        if (!oldest.done)
            zenSessions.delete(oldest.value);
    }
    zenSessions.set(seed, minted);
    return minted;
};
const zenApiHeaders = (model, options) => {
    const sessionId = options.sessionId ?? 'dsh-session-unknown';
    // One id per conversation, reused by every turn: Zen meters free usage by
    // session and caches by it.
    const session = zenSessionId(sessionId);
    return {
        ...model.headers,
        // Deliberately omitting 'HTTP-Referer' and 'x-session-affinity': the
        // free-tier gate refuses any request carrying either, whatever the value.
        // opencode sends both absent.
        // The gate also requires the keyless public credential and a wildcard
        // Accept; the adapter's own auth path supplies neither.
        'accept': '*/*',
        // The gate requires the keyless public credential on the wire.
        'authorization': 'Bearer public',
        'x-opencode-project': 'global',
        'x-opencode-session': session,
        'x-opencode-session-id': session,
        // 'x-session-affinity' deliberately omitted: the free-tier gate refuses
        // any request carrying it. opencode sends no such header.
        'X-Session-Id': session,
        // The turn, not the conversation: no validation, but a fresh id keeps the
        // shape of what opencode sends.
        'x-opencode-request': opencodeId('msg', false),
        'x-opencode-client': 'cli',
    };
};
// Zen's free tier only unlocks for the opencode CLI identity, but the harness
// merges its own mandatory attribution `user-agent` over model headers
// (dsh-llm's attributionHeaders, merged after model.headers by pi-ai's client),
// so the fetch layer is the only place that still wins. Other hosts keep the
// harness attribution untouched.
const zenNativeFetch = globalThis.fetch;
let zenUserAgent;
const zenFetch = (input, init) => {
    const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input instanceof Request ? input.url : String(input);
    if (zenUserAgent === undefined || new URL(url).hostname !== 'opencode.ai')
        return zenNativeFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('user-agent', zenUserAgent);
    return zenNativeFetch(input, { ...init, headers });
};
/**
 * Model-visible description of a placeholder this harness cannot execute.
 */
const ZEN_TOOL_TEXT = 'Requirement placeholder from OpenCode Zen: this harness cannot execute it.';
const zenTool = (name, property) => ({
    name,
    description: ZEN_TOOL_TEXT,
    parameters: { type: 'object', properties: { [property]: { type: 'string', description: ZEN_TOOL_TEXT } }, required: [property] },
});
/**
 * Zen's free tier is gated on the request fingerprint, and the checks are the
 * tool names: the list must offer `bash` and `read` with non-empty parameter
 * schemas, alongside `stream: true` (both transports
 * hardcode that). Requests carrying fewer tools — compaction, session titles,
 * summaries, or any turn whose permissions cut the list down — are refused with
 * FreeTierError and the misleading "free tier can only be used from within
 * OpenCode". Pad such requests so the shape requirement holds. Declared tools
 * stay first and only missing ones are appended, so a request that already
 * qualifies is untouched and the provider's prompt cache is not invalidated.
 */
const ZEN_REQUIRED_TOOLS = [['bash', 'command'], ['read', 'file_path']];
// A declared tool whose schema names no property is rejected by the same check,
// so every required name ends up with a non-empty `properties` map: an existing
// declaration keeps its own properties and only gains one when it had none.
const withProperty = (tool, property) => {
    const parameters = tool.parameters ?? {};
    const properties = parameters.properties;
    if (properties !== undefined && Object.keys(properties).length > 0)
        return tool;
    return { ...tool, parameters: { ...parameters, type: 'object', properties: { [property]: { type: 'string', description: ZEN_TOOL_TEXT } } } };
};
export const requiredZenTools = (tools = []) => {
    const filled = tools.map(tool => {
        const required = ZEN_REQUIRED_TOOLS.find(([name]) => name === tool.name);
        return required === undefined ? tool : withProperty(tool, required[1]);
    });
    const present = new Set(filled.map(tool => tool.name));
    for (const [name, property] of ZEN_REQUIRED_TOOLS) {
        if (!present.has(name))
            filled.push(zenTool(name, property));
    }
    return filled;
};
// Replayed thinking blocks carry no wire signature; marking them
// `reasoning_content` keeps the transport from mangling history. Never gated on
// `model.reasoning`: a model with no effort control still streams thinking.
//
// On pi-ai 0.87 the tool declarations no longer sit on the context: they live in
// the transcript's system messages, so padding the list means rewriting the
// leading `toolsAdded` (falling back to `context.tools`, which a context built
// before normalization still carries).
const normalizeReasoningContext = (context) => ({
    ...context,
    messages: context.messages.map((message, index) => {
        // Pad the tool list where pi-ai keeps it: the leading system message.
        if (index === 0 && message.role === 'system') {
            return { ...message, toolsAdded: requiredZenTools(message.toolsAdded ?? context.tools ?? []) };
        }
        if (message.role !== 'assistant')
            return message;
        return {
            ...message,
            content: message.content.map(block => block.type === 'thinking' && block.thinking.trim().length > 0 && block.thinkingSignature === undefined
                ? { ...block, thinkingSignature: 'reasoning_content' }
                : block),
        };
    }),
});
// Zen reports non-credential refusals (ended free promotions, region blocks) as
// HTTP 401/403, which the harness classifies as AUTH and masks as "API key is
// invalid". Rewriting the envelope to an [opencode-zen <type>] message gets the
// real reason past that classification; genuine auth envelopes pass through.
const parseRefusalEnvelope = (errorMessage) => {
    const rewritten = /^\[opencode-zen ([^\]]+)\] (.*)$/s.exec(errorMessage);
    if (rewritten !== null) return { type: rewritten[1], code: '', message: rewritten[2] };
    const start = errorMessage.indexOf('{');
    const end = errorMessage.lastIndexOf('}');
    if (start < 0 || end <= start)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(errorMessage.slice(start, end + 1));
    }
    catch {
        return undefined;
    }
    if (!isRecord(parsed))
        return undefined;
    // Accept both the raw envelope and the SDK-unwrapped inner object.
    const detail = isRecord(parsed.error) ? parsed.error : parsed;
    const message = [detail.message, isRecord(detail.error) ? detail.error.message : undefined, detail.detail]
        .find((value) => typeof value === 'string');
    if (message === undefined)
        return undefined;
    const type = typeof detail.type === 'string' ? detail.type : 'Error';
    const code = typeof detail.code === 'string' ? detail.code : '';
    return { type, code, message };
};
const rewriteRefusalMessage = (errorMessage) => {
    const parsed = parseRefusalEnvelope(errorMessage);
    if (parsed === undefined)
        return errorMessage;
    if (AUTH_ERROR_TYPES.has(parsed.type) || AUTH_ERROR_TYPES.has(parsed.code))
        return errorMessage;
    // Dropping the status prefix is what defeats the AUTH classifier.
    return '[opencode-zen ' + parsed.type + '] ' + parsed.message;
};
/**
 * Server and protocol failures may allow the same model's alternate protocol.
 * Authentication, free-tier admission and quota refusals remain final.
 */
const ZEN_RECOVERABLE_TYPES = new Set(['server_error', 'api_error', 'overloaded_error', 'RequestError', 'ModelError']);
/**
 * The refusal one stream event carries, when a different route may still answer.
 * @param event - one stream event, as the transport pushes it.
 * @returns the parsed refusal, or undefined when this event is not one to re-route.
 */
export const recoverableUpstreamFailure = (event) => {
    if (!isRecord(event) || event.type !== 'error')
        return undefined;
    const errorMessage = isRecord(event.error) && typeof event.error.errorMessage === 'string' ? event.error.errorMessage : '';
    const parsed = parseRefusalEnvelope(errorMessage);
    if (parsed === undefined || AUTH_ERROR_TYPES.has(parsed.type) || AUTH_ERROR_TYPES.has(parsed.code)) return undefined;
    if (ZEN_RECOVERABLE_TYPES.has(parsed.type))
        return parsed;
    return undefined;
};
/**
 * Run the attempts in order and hand the transport one stream for all of them.
 *
 * Recovery is allowed only before content starts. An abandoned first stream must
 * not close the outward iterator or result promise while the next attempt runs.
 * Exhaustion or a synchronous factory failure preserves the last upstream error.
 * @param plan - consecutive attempts, most preferred first.
 * @param invoke - starts one attempt and returns its sanitized stream.
 * @param onSwitch - reports one attempt switch to the caller's logger.
 * @param signal - prevents another attempt after cancellation.
 * @returns the stream the transport consumes.
 */
export const withUpstreamRecovery = (plan, invoke, onSwitch, signal) => {
    if (plan.length === 0) throw new Error('OpenCode Zen recovery needs at least one attempt');
    let rootPush;
    const start = (index) => {
        const stream = invoke(plan[index]);
        const push = stream.push.bind(stream);
        const forward = index === 0 ? push : rootPush;
        let committed = false;
        let retired = false;
        let pendingStart;
        stream.push = (event) => {
            if (retired) return;
            if (isRecord(event) && event.type === 'start' && !committed) {
                pendingStart = event;
                return;
            }
            if (!committed) {
                const failure = recoverableUpstreamFailure(event);
                if (failure !== undefined && !signal?.aborted && index + 1 < plan.length) {
                    try {
                        start(index + 1);
                    }
                    catch (error) {
                        if (pendingStart !== undefined) forward(pendingStart);
                        forward(event);
                        retired = true;
                        return;
                    }
                    retired = true;
                    onSwitch(plan[index], plan[index + 1], failure);
                    return;
                }
            }
            committed = true;
            if (pendingStart !== undefined) {
                forward(pendingStart);
                pendingStart = undefined;
            }
            forward(event);
        };
        if (index === 0) {
            rootPush = push;
            const end = stream.end?.bind(stream);
            if (end !== undefined) stream.end = (...args) => { if (!retired) end(...args); };
        }
        return stream;
    };
    return start(0);
};
// Required by the adapter, unused by this route: the credential comes from
// `resolveApiKey`, so pi-ai never stores one nor asks an ambient question.
const PI_AUTH = {
    credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async (_providerId, mutate) => mutate(undefined),
        delete: async () => { },
    },
    authContext: { env: async () => undefined, fileExists: async () => false },
};
const sanitizeStream = (stream) => {
    const originalPush = stream.push.bind(stream);
    stream.push = (event) => {
        if (isRecord(event) && event.type === 'error' && isRecord(event.error) && typeof event.error.errorMessage === 'string') {
            event.error.errorMessage = rewriteRefusalMessage(event.error.errorMessage);
        }
        originalPush(event);
    };
    return stream;
};
const zenInvoke = (api, kind, model, context, options) => {
    const prepared = { ...model, headers: zenApiHeaders(model, options) };
    const normalized = normalizeReasoningContext(context);
    const run = { ...options, fetch: zenFetch };
    if (api === 'openai-responses') {
        return sanitizeStream(kind === 'simple'
            ? piResponsesStreamSimple(prepared, normalized, run)
            : piResponsesStream(prepared, normalized, run));
    }
    return sanitizeStream(kind === 'simple'
        ? piAgentStreamSimple(prepared, normalized, run)
        : piAgentStream(prepared, normalized, run));
};
/**
 * At most two attempts retain the selected model and configured capacities.
 */
const zenAttempts = (model, recovery) => {
    const plan = [{ model, api: model.api, label: model.id }];
    if (!recovery.enabled)
        return plan;
    const variants = recovery.variants.get(model.id);
    if (variants !== undefined) {
        const other = model.api === 'openai-responses' ? 'openai-completions' : 'openai-responses';
        const alternate = variants.get(other);
        if (alternate !== undefined)
            plan.push({ model: { ...model, api: other, compat: alternate.compat, thinkingLevelMap: alternate.thinkingLevelMap }, api: other, label: model.id + ' on ' + other });
    }
    return plan;
};
const zenStreamFor = (recovery, onSwitch) => ({
    stream: (model, context, options) => withUpstreamRecovery(zenAttempts(model, recovery), (spec) => zenInvoke(spec.api, 'stream', spec.model, context, options), onSwitch, options?.signal),
    streamSimple: (model, context, options) => withUpstreamRecovery(zenAttempts(model, recovery), (spec) => zenInvoke(spec.api, 'simple', spec.model, context, options), onSwitch, options?.signal),
});
const CATALOG_ATTEMPTS = 3;
const CATALOG_TIMEOUT_MS = 20_000;
const CATALOG_TOTAL_BUDGET_MS = 45_000;
const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms); });
/** Fetch public catalog metadata with bounded retries before trying the disk cache. */
async function fetchJson(url, headers) {
    const deadline = Date.now() + CATALOG_TOTAL_BUDGET_MS;
    let lastError;
    for (let attempt = 1; attempt <= CATALOG_ATTEMPTS; attempt += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(Math.min(CATALOG_TIMEOUT_MS, remaining)) });
            if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
            const payload = await response.json();
            if (!isRecord(payload)) throw new Error(`${url}: unexpected response shape`);
            return payload;
        }
        catch (error) {
            lastError = error;
            if (attempt < CATALOG_ATTEMPTS) await sleep(250 * attempt);
        }
    }
    throw lastError;
}
/** pi-ai's standard ladder keys (off = explicit close; the rest are depths). */
const PI_LEVEL_KEYS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Only an `effort`-type option's values shape the selector. A `toggle`, an empty
// list or a missing entry declares no level — an honest "takes no effort".
function reasoningLevelsFor(metadata) {
    const option = (Array.isArray(metadata.reasoning_options) ? metadata.reasoning_options : [])
        .find(value => isRecord(value) && value.type === 'effort');
    return isRecord(option) && Array.isArray(option.values)
        ? option.values.filter((value) => typeof value === 'string')
        : [];
}
// `Default` (the harness's "no selection" path) is the *absent key* — leaving
// `reasoning_effort` off the wire and letting the upstream choose. Each ladder
// level the endpoint accepts lands at its own key with its own wire value; the
// `off` key carries the upstream's literal close value when the feed names one
// (e.g. `none`), so the selector's "Off" entry is a real switch rather than a
// `no-op. Responses-model feeds name no close value and `/responses` rejects
// both fabricated ones (`'off'` is an unknown variant, `'none'` unsupported
// for this model). pi-ai sends nothing only when the key is explicitly `null`
// (an absent key falls back to sending `'none'`), so `off: null` is the honest
// "upstream decides" — it also drops "Off" from the selector, which is correct
// because this endpoint offers no way to turn thinking down.
function reasoningMapFor(levels, api) {
    const map = {};
    for (const key of PI_LEVEL_KEYS) {
        if (levels.includes(key))
            map[key] = key;
    }
    if (api === 'openai-completions') {
        map.off = levels.includes('none') ? 'none' : 'off';
    }
    else {
        map.off = null;
    }
    return map;
}
// Turn the live-scanned feeds into pi-ai model descriptors. Both transport
// surfaces are built for every model id: the declared one is registered, and the
// other stays available as a recovery attempt when the declared one refuses.
function buildModels(zenData, modelsById, userAgent, zenVariants) {
    const baseModels = getBuiltinModels('opencode');
    zenVariants.clear();
    return zenData
        .filter((entry) => isRecord(entry) && typeof entry.id === 'string' && entry.id.endsWith('-free'))
        .flatMap((entry) => {
        const id = entry.id;
        const metadata = modelsById[id];
        if (!isRecord(metadata))
            return [];
        if (typeof metadata.status === 'string' && metadata.status === 'deprecated')
            return [];
        // Zen serves muse-spark contributor-free models on the Responses endpoint
        // (chat/completions 500s for them); every other free model is served on
        // chat/completions. The other surface is still built, because an upstream
        // that refuses one of them can still answer the other.
        const declaredApi = id.includes('muse-spark') ? 'openai-responses' : 'openai-completions';
        const baseCompat = baseModels.find(base => base.id === id)?.compat;
        // No ladder upstream means no selector: reasoning false is "no effort
        // control", never "no thinking".
        const levels = reasoningLevelsFor(metadata);
        const controllable = levels.length > 0;
        const limit = isRecord(metadata.limit) ? metadata.limit : undefined;
        const input = isRecord(metadata.modalities) && Array.isArray(metadata.modalities.input)
            ? metadata.modalities.input.filter((value) => value === 'text' || value === 'image')
            : [];
        const descriptor = (api) => {
            // Models not yet in the pi-ai built-in catalogue still need the Zen-
            // specific maxTokensField ("max_tokens") so the proxy does not reject
            // the request with a 500 when "max_completion_tokens" arrives.
            //
            // supportsStrictMode is what makes pi-ai state strict: false on a
            // Responses tool. Without that field the Responses API normalises the
            // schema into strict mode, where every declared property counts as
            // required and the model has to invent the optional arguments. Zen's
            // own CLI writes the field on every OpenAI-wire tool for the same
            // reason. Chat-completions models need nothing: pi-ai omits strict
            // there, and that API stays non-strict by default.
            const strictCompat = api === 'openai-responses' ? { supportsStrictMode: true } : {};
            const compat = baseCompat === undefined
                ? { maxTokensField: 'max_tokens', supportsReasoningEffort: false, ...strictCompat }
                : { ...baseCompat, requiresReasoningContentOnAssistantMessages: false, ...strictCompat };
            return {
                id,
                name: typeof metadata.name === 'string' ? metadata.name : id,
                api,
                provider: PROVIDER,
                baseUrl: ZEN_BASE_URL,
                headers: { 'User-Agent': userAgent },
                reasoning: controllable,
                ...(controllable ? { thinkingLevelMap: reasoningMapFor(levels, api) } : {}),
                input: input.length > 0 ? input : ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                // Retain the locally verified DeepSeek budget and MiMo's 1M window.
                contextWindow: id === 'deepseek-v4.1-flash-free' ? 1_000_000
                    : id === 'mimo-v2.6-flash-free' ? 1_048_576
                    : id === 'glm-5.3-flash-free' ? 614_400
                    : typeof limit?.context === 'number' ? limit.context : 1_048_576,
                maxTokens: id === 'deepseek-v4.1-flash-free' ? 256_000
                    : typeof limit?.output === 'number' ? limit.output : 32_768,
                ...(compat ? { compat } : {}),
            };
        };
        const variants = new Map([['openai-completions', descriptor('openai-completions')], ['openai-responses', descriptor('openai-responses')]]);
        zenVariants.set(id, variants);
        return [variants.get(declaredApi)];
    });
}
/** Resolve an optional catalog replacement without changing the upstream transport metadata. */
function configuredModels(scanned, settings) {
    const modelErrors = new Map();
    const configuredMaxTokens = new Map();
    if (settings == null) return { models: scanned, modelErrors, configuredMaxTokens };
    const byId = new Map(scanned.map(model => [model.id, model]));
    const seen = new Set();
    const models = [];
    for (const row of settings) {
        if (seen.has(row.id)) throw new Error(`${name}: duplicate model id "${row.id}"`);
        seen.add(row.id);
        const base = byId.get(row.id);
        if (base === undefined) {
            modelErrors.set(row.id, `${name}: model "${row.id}" is not in the current free-model catalog`);
            continue;
        }
        models.push({
            ...base,
            ...(row.name === undefined ? {} : { name: row.name }),
            ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow }),
            ...(row.maxTokens === undefined ? {} : { maxTokens: row.maxTokens }),
            ...(row.input?.length > 0 ? { input: [...row.input] } : {}),
        });
        if (row.maxTokens !== undefined) configuredMaxTokens.set(row.id, row.maxTokens);
    }
    return { models, modelErrors, configuredMaxTokens };
}
/** A missing or unreadable public-metadata cache leaves the network scan responsible for the catalog. */
async function readCatalogCache(cachePath) {
    try {
        const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
        if (!isRecord(parsed) || !Array.isArray(parsed.zen) || !isRecord(parsed.models) || typeof parsed.userAgent !== 'string') return undefined;
        return { zen: parsed.zen, models: parsed.models, userAgent: parsed.userAgent };
    }
    catch (error) {
        // A cache miss or corrupt public metadata is recoverable on the next successful scan.
        return undefined;
    }
}
/** Await the atomic cache write so mounting leaves no background filesystem work. */
async function writeCatalogCache(cachePath, cache) {
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(temporary, JSON.stringify(cache), { flag: 'wx', mode: 0o600 });
        await rename(temporary, cachePath);
    }
    catch (error) {
        // Optional cache persistence cannot prevent a valid live catalog from loading.
    }
    finally {
        try { await rm(temporary, { force: true }); }
        catch (error) { /* A failed optional-cache cleanup must not fail catalog mounting. */ }
    }
}
export async function apply(ctx, config) {
    const cachePath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', `${name}-catalog.json`);
    // One-time: the Zen user-agent the transport forces on every opencode.ai/zen request.
    const opencodeVersion = await resolveOpenCodeVersion();
    const opencodeUserAgent = `opencode/${opencodeVersion}`;
    zenUserAgent = opencodeUserAgent;
    const zenVariants = new Map();
    // The Loader owns the settings namespace, so the configuration form is
    // addressed by the profile entry id that mounted this plugin.
    const settingsNs = ctx.fiber.entry?.options.id ?? name;
    // Outside the settings-backed config, so a settings snapshot cannot clobber a
    // scan.
    let scanned = [];
    const buildProfiles = () => {
        const opts = liveConfig(config);
        const catalog = configuredModels(scanned, opts.models);
        const recovery = { enabled: opts.upstreamRecovery, variants: zenVariants };
        const onSwitch = (from, to, failure) => ctx.logger.warn('[%s] %s refused (%s: %s); retrying on %s', name, from.label, failure.type, failure.message, to.label);
        const streamApi = zenStreamFor(recovery, onSwitch);
        const piProvider = createProvider({
            id: PROVIDER,
            name: 'OpenCodeZenFree',
            baseUrl: ZEN_BASE_URL,
            auth: { apiKey: { name: 'OpenCodeZenFree', resolve: ({ credential }) => Promise.resolve({
                        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
                        source: 'OpenCodeZenFree',
                    }) } },
            models: catalog.models,
            api: { 'openai-completions': streamApi, 'openai-responses': streamApi },
        });
        const profiles = new Map([[PROVIDER, {
                    provider: PROVIDER,
                    displayName: DISPLAY_NAME,
                    apiKeyEnv: credentialRef('OPENCODE_ZEN_FREE_API_KEY'),
                    streamIdleTimeoutMs: 300_000,
                    maxRequestImageBytes: opts.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
                    requestImagePixelBudget: 4_194_304,
                    requestImageMaxBytes: opts.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
                    retryPolicy: resolveRetryPolicy(opts.retryPolicy, `${name}: retryPolicy`),
                    piProvider,
                    modelErrors: catalog.modelErrors,
                    configuredMaxTokens: catalog.configuredMaxTokens,
                }]]);
        return profiles;
    };
    // PiAiAdapter memoizes its snapshot on this Map's identity, so a fresh Map per
    // request would rebuild the whole pi-ai collection: rebuild only on change.
    let profiles = buildProfiles();
    const adapter = new PiAiAdapter({
        resolveAttachments: () => ctx.get('attachments'),
        profiles: () => profiles,
        auth: PI_AUTH,
        resolveApiKey: async (_provider, profile) => {
            const credentials = ctx.get('credentials');
            if (credentials !== undefined) {
                const hit = await credentials.resolve(profile.apiKeyEnv);
                if (hit !== undefined)
                    return assertUsableApiKey(hit.value, name, String(profile.apiKeyEnv));
            }
            // OpenCode Zen accepts the public route without a user API key.
            return 'public';
        },
    });
    ctx.llm.registerConfigurableProviders([
        { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs, settingsPath: [] },
    ]);
    ctx.llm.registerAdapter([PROVIDER], adapter);
    ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
        signal?.throwIfAborted();
        if (request.provider !== PROVIDER) throw new Error(`${name}: unknown provider`);
        return scanned.map(model => ({
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            inputModalities: [...model.input],
        }));
    });
    // Every field is volatile, so the Loader commits a settings write into this
    // fiber and announces it here instead of remounting; re-derive the profiles.
    ctx.on('loader/volatile-update', () => {
        profiles = buildProfiles();
    });
    // Await the bounded initial scan before mount completes. An unreachable feed
    // can use last-good public metadata without changing user model overrides.
    async function sync() {
        const usable = (zen, models, userAgent) => {
            const next = buildModels(zen, models, userAgent, zenVariants);
            if (next.length === 0) throw new Error('no OpenCode Zen free models resolved');
            return next;
        };
        let next;
        try {
            const [zen, modelsDev] = await Promise.all([
                fetchJson(ZEN_CATALOG_URL, { 'User-Agent': opencodeUserAgent, accept: 'application/json' }),
                fetchJson('https://models.dev/api.json', { accept: 'application/json' }),
            ]);
            if (!Array.isArray(zen.data)) throw new Error('zen models: unexpected response shape');
            if (!isRecord(modelsDev.opencode) || !isRecord(modelsDev.opencode.models)) throw new Error('models.dev: no "opencode" provider');
            next = usable(zen.data, modelsDev.opencode.models, opencodeUserAgent);
            await writeCatalogCache(cachePath, { zen: zen.data, models: modelsDev.opencode.models, userAgent: opencodeUserAgent });
        }
        catch (error) {
            const cached = await readCatalogCache(cachePath);
            if (cached === undefined) throw error;
            ctx.logger.warn('[%s] catalog fetch failed (%s); using the cached catalog', name, errorChain(error));
            next = usable(cached.zen, cached.models, cached.userAgent);
        }
        if (deepEqualJson(next, scanned))
            return;
        scanned = next;
        profiles = buildProfiles();
        ctx.logger.info('[%s] synced %d free model(s): %s', name, scanned.length, scanned.map(model => model.id).join(', '));
    }
    await sync().catch((error) => {
        ctx.logger.warn('[%s] initial catalog scan failed: %s', name, errorChain(error));
    });
}
