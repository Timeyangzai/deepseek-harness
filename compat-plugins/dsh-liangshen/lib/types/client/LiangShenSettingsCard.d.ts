/**
 * LiangShen settings card: availability and the wire presentation. Registers
 * into the `web-ui.plugin.item` child slot the Web UI plugin group renders,
 * bound to the `dsh-liangshen` namespace.
 *
 * The presentation field does not act on this client half: the Host writes it
 * into the synced preset composition, so a session reads it from its preset.
 * This card is the operator's only handle on it, which is why every field the
 * Host schema carries appears here.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client';
import { type CardActions, type CardShell, type FieldState as CardFieldState } from './settings-form.ts';
/** Wire presentations the tool catalog accepts (mirrors the Host schema). */
export declare const PRESENTATION_CHOICES: readonly ["ptc", "native", "both"];
/** The LiangShen fields this card edits (the namespace's full schema). */
export interface LiangShenSettings {
    /** Master switch for the plugin. */
    enabled?: boolean;
    /** Whether the plugin announces itself in every agent's system prompt. */
    announceToAgent?: boolean;
    /** Wire presentation written into the synced preset. */
    presentation?: string;
}
/** What the LiangShen card renders. */
export interface LiangShenSettingsCardState extends CardShell {
    enabled: CardFieldState;
    announceToAgent: CardFieldState;
    presentation: CardFieldState;
}
/** The registration-side face the card's slot entry injects. */
export interface LiangShenSettingsCardFace extends CardActions {
    hooks: {
        /** Card snapshot bound by the renderer as useLiangShenSettingsCard. */
        liangShenSettingsCard: SnapshotStore<LiangShenSettingsCardState>;
    };
}
/** Bridges the `dsh-liangshen` scope onto the card's staged form. */
export declare class LiangShenSettingsCardController {
    private readonly form;
    private readonly store;
    /** @param scope - the bound settings scope for the `dsh-liangshen` namespace. */
    constructor(scope: SettingsScope<LiangShenSettings>);
    private projection;
    /**
     * Build the face the card's slot registration injects.
     * @returns the card's snapshot and its form actions.
     */
    inject(): LiangShenSettingsCardFace;
    /** Release the card's scope subscription and bound stores. */
    dispose(): void;
}
/** Props the renderer binds for the LiangShen card. */
export type LiangShenSettingsCardProps = PropsRuntime<'web-ui.plugin.item'> & PropsLocale<'liangshen'> & InjectFace<LiangShenSettingsCardFace>;
/**
 * Render the LiangShen card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export declare function LiangShenSettingsCard(props: LiangShenSettingsCardProps): import("react").JSX.Element;
