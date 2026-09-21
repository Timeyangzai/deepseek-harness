/**
 * Sync every preset directory under `sourceRoot` into `targetRoot` — the
 * dsh agent-presets discovery root (harness-home `.agent-presets`).
 *
 * A preset is a directory holding `agent.cordis.yml`; the directory name is
 * the preset id. Copy is per-directory and idempotent: a preset whose target
 * tree is byte-identical to the source tree is skipped, otherwise the source
 * tree is copied and any target files the source does not contain are removed.
 * Directories the plugin does not own (other presets the user authored) are
 * never touched.
 *
 * After a preset is synced its `agent.cordis.yml` is validated against the
 * structural preset schema; a validation failure is reported through the
 * run's `failed` entries instead of being a warn-only side effect, so callers
 * can observe (and surface) a broken preset rather than silently shipping it.
 */
/** One sync run's outcome, grouped for diagnostics. */
export interface SyncResult {
    /** Preset ids whose tree was (re)written this run. */
    synced: string[];
    /** Preset ids already current — nothing copied. */
    current: string[];
    /** Preset ids that failed, with the underlying error message. */
    failed: {
        id: string;
        error: string;
    }[];
    /** Previously bundled preset ids removed from the target root this run. */
    retired: string[];
}
/**
 * The preset-row settings the plugin exposes in the web settings surface, as the
 * overrides to write into the synced `agent.cordis.yml`.
 *
 * The settings surface edits the PLUGIN's namespace, while the values that shape
 * a session live in the preset's rows. Writing the chosen values into the synced
 * tree is what connects the two: the bundled source stays the shipped default,
 * and the operator's choice rides on top of it. Every field is optional — an
 * absent value leaves the shipped row exactly as it is.
 */
export interface PresetOverrides {
    /** The `tool-catalog` row's `presentation` value. */
    presentation?: string;
}
/**
 * Render `agent.cordis.yml` with the settings overrides applied.
 *
 * Rows are matched by their `- id:` marker, so the transform does not depend on
 * line numbers or on the values the shipped file happens to carry. A row or key
 * the source does not contain is left alone rather than invented: the overlay
 * narrows the shipped configuration, it never adds a mount the preset did not
 * have.
 * @param text - the bundled preset composition.
 * @param overrides - the operator's settings-surface choices.
 * @returns the composition to write into the synced tree.
 */
export declare function renderPresetOverrides(text: string, overrides: PresetOverrides): string;
/** Copy `sourceRoot/<id>` into `targetRoot/<id>`, idempotently. */
export declare function syncOnePreset(sourceDir: string, targetDir: string, overrides?: PresetOverrides): 'synced' | 'current';
/**
 * Sync every preset under `sourceRoot` into `targetRoot`, then remove
 * target directories named in `retire` that the bundle no longer ships —
 * preset ids the plugin once owned and later dropped. Only those exact ids
 * are removed; every other target directory is left untouched.
 *
 * Each synced (or already-current) preset is validated against the structural
 * `agent.cordis.yml` schema; a validation failure lands in `failed` so the
 * caller can surface a broken preset as a first-class result instead of a
 * warn-only log line.
 * @param sourceRoot - plugin-owned preset tree (bundled in the package).
 * @param targetRoot - dsh agent-presets discovery root (e.g. <home>/.dsh/.agent-presets).
 * @param retire - previously bundled preset ids to remove when absent from the source.
 */
export declare function syncPresetTrees(sourceRoot: string, targetRoot: string, retire?: string[], overrides?: PresetOverrides): SyncResult;
