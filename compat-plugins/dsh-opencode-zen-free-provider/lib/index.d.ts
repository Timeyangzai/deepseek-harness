import type { Context } from '@deepseek-ai/cordis';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { type Tool } from '@earendil-works/pi-ai';
export declare const name = "opencode-zen-free-provider";
export declare const inject: string[];
export interface ModelSettings {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: ('text' | 'image')[];
}
export interface Config {
    /** null or omission inherits the live catalog; an array replaces it. */
    models?: ModelSettings[] | null;
    /** Base64 image payload one request accepts before older images are offloaded (default 2 MiB). */
    maxRequestImageBytes?: number;
    /** Per-image request budget after re-encoding (default 1 MiB). */
    requestImageMaxBytes?: number;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
    /** Re-route the first refusal of a request instead of failing the turn (default true). */
    upstreamRecovery?: boolean;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    models: z<ModelSettings[] | null, ModelSettings[] | null, "volatile-defined">;
    maxRequestImageBytes: z<number, number, "volatile-defined">;
    requestImageMaxBytes: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
    upstreamRecovery: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    models: z<ModelSettings[] | null, ModelSettings[] | null, "volatile-defined">;
    maxRequestImageBytes: z<number, number, "volatile-defined">;
    requestImageMaxBytes: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<RetryPolicyConfig>, NoInfer<RetryPolicyConfig>, "volatile">;
    upstreamRecovery: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
/**
 * {@link Config} as the Loader holds it: every field is volatile, so a settings write
 * reaches the running plugin as a committed reference instead of remounting it, and
 * the field is one the settings service shows a form for.
 */
type LiveConfig = Schemastery.TypeT<typeof Config>;
export declare const requiredZenTools: (tools?: readonly Tool[]) => Tool[];
/** The refusal one stream event carries, when a different route may still answer. */
export declare const recoverableUpstreamFailure: (event: unknown) => { type: string; code: string; message: string } | undefined;
/** Run the attempts in order and hand the transport one stream for all of them. */
export declare const withUpstreamRecovery: <Attempt, Stream extends { push: (event: unknown) => void; end?: () => void }>(plan: readonly Attempt[], invoke: (attempt: Attempt) => Stream, onSwitch: (from: Attempt, to: Attempt, failure: { type: string; message: string }) => void, signal?: AbortSignal) => Stream;
export declare function apply(ctx: Context, config: LiveConfig): Promise<void>;
export {};
