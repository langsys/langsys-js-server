/**
 * Server messages (the MSG family), server profile.
 *
 * Translation needs two things from a failure: `template`, the framework's own sentence before its
 * values are filled, with the field's label written in (MSG-3), and `params`, the non-translatable
 * values that fill its `{name}` markers. `message` is the template filled, the fallback a client
 * shows when it cannot look the template up (MSG-1, MSG-4). Everything else is the framework's and
 * passes through unchanged: its field path, and its own identifier for the failure as `code`
 * (MSG-2). The marker grammar, `fill`, and resolving entries out of a response body are the core's.
 */
import { fillTemplate, templateMarkers } from 'langsys-js-typescript/pure';

export {
    DEFAULT_SERVER_MESSAGE_CATEGORY,
    fillTemplate,
    resolveServerMessages,
    templateMarkers,
    toServerMessage,
} from 'langsys-js-typescript/pure';

/** One server message entry (MSG-1). */
export interface ServerMessage {
    /** The failing field, in the framework's own path format, when the framework reports one. */
    field?: string;
    /** The framework's own identifier for the failure, passed through; never used to choose text. */
    code?: string;
    /** The template filled with its params. */
    message: string;
    /** The whole source sentence, the phrase that is registered and translated. */
    template: string;
    /** Present only when the template has markers. Non-translatable values only. */
    params?: Record<string, unknown>;
}

export interface MessageInput {
    code?: string;
    template: string;
    params?: Record<string, unknown>;
    field?: string;
}

/**
 * The label placeholders of this ecosystem's validators (MSG-11 check 1): class-validator's
 * `$property`, yup's `${path}` and `${label}`, joi's `{{#label}}` and `{{#key}}`. A template still
 * holding one should have had the field's label written in (MSG-3).
 */
const LABEL_PLACEHOLDERS: { pattern: RegExp; framework: string }[] = [
    { pattern: /\$property\b/, framework: 'class-validator' },
    { pattern: /\$\{\s*(?:path|label)\s*\}/, framework: 'yup' },
    { pattern: /\{\{\s*#(?:label|key)\s*\}\}/, framework: 'joi' },
];

/** Why a template may not be declared, or `null` when it may (MSG-11 check 1). */
export function checkTemplate(template: string): string | null {
    for (const { pattern, framework } of LABEL_PLACEHOLDERS) {
        const found = template.match(pattern);
        if (found) return `${found[0]} is a label placeholder (${framework}); write the field's label into the sentence`;
    }
    return null;
}

/** Build an entry: `message` is the template filled, `params` only when it has markers (MSG-4). */
export function buildMessage(input: MessageInput): ServerMessage {
    const hasMarkers = templateMarkers(input.template).length > 0;
    return {
        ...(typeof input.field === 'string' && input.field !== '' ? { field: input.field } : {}),
        ...(typeof input.code === 'string' && input.code !== '' ? { code: input.code } : {}),
        message: fillTemplate(input.template, input.params ?? {}),
        template: input.template,
        ...(hasMarkers && input.params ? { params: input.params } : {}),
    };
}
