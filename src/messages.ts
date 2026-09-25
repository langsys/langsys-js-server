/**
 * Server messages (the MSG family), server profile.
 *
 * An entry is `{ field?, code, message, template, params? }` with those keys fixed (MSG-1): `code`
 * is the logic slug (MSG-2), `template` the whole source sentence (MSG-3), `params` the
 * non-translatable values that fill its markers, and `message` the template filled (MSG-4). The
 * marker grammar, `fill`, and resolving entries out of a response body are the core's, so every
 * SDK reads a template the same way; this module adds what a server does: checking a template
 * when it is declared, and building entries.
 */
import { fillTemplate, templateMarkers } from 'langsys-js-typescript/pure';

export {
    DEFAULT_SERVER_MESSAGE_CATEGORY,
    SERVER_MESSAGE_CODES,
    fillTemplate,
    resolveServerMessages,
    templateMarkers,
    toServerMessage,
} from 'langsys-js-typescript/pure';

/** One server message entry (MSG-1). */
export interface ServerMessage {
    /** Dotted path of the failing field, for a field failure: `items.3.label`. */
    field?: string;
    /** The stable snake_case slug an app branches on; never used to choose text. */
    code: string;
    /** The template filled with its params. */
    message: string;
    /** The whole source sentence, the phrase that is registered and translated. */
    template: string;
    /** Present only when the template has markers. Non-translatable values only. */
    params?: Record<string, unknown>;
}

export interface MessageInput {
    code: string;
    template: string;
    params?: Record<string, unknown>;
    field?: string;
}

/** Marker names that carry a label by construction (MSG-11): a label is written in, never markered. */
const LABEL_MARKERS = ['attribute', 'field', 'label', 'other', 'values'];

/** A framework placeholder left in the text: Laravel's `:attribute`, a `{{field}}` template slot. */
const FRAMEWORK_PLACEHOLDER = /(?:^|[\s("'])(:[a-z][a-z_]*)\b|(\{\{\s*[A-Za-z_][\w.]*\s*\}\})/;

/**
 * Why a template may not be declared, or `null` when it may (MSG-3, MSG-11 check 1). A template
 * is refused when a marker's name carries a label by construction, or when a framework
 * placeholder that should have been written in is still in the text.
 */
export function checkTemplate(template: string): string | null {
    // The placeholder first: `{{field}}` also contains the marker `{field}`, and the leftover
    // placeholder is the precise diagnosis.
    const leftover = template.match(FRAMEWORK_PLACEHOLDER);
    if (leftover) {
        return `${leftover[1] ?? leftover[2]} is a framework placeholder; write the value into the sentence`;
    }
    const labelled = templateMarkers(template).find((name) => LABEL_MARKERS.includes(name));
    if (labelled) {
        return (
            `the marker {${labelled}} carries a label, which must be written into the sentence ` +
            'so the translation agrees with it; markers are for numbers, dates and raw input only'
        );
    }
    return null;
}

/** Build an entry: `message` is the template filled, `params` only when it has markers (MSG-4). */
export function buildMessage(input: MessageInput): ServerMessage {
    const hasMarkers = templateMarkers(input.template).length > 0;
    return {
        ...(typeof input.field === 'string' && input.field !== '' ? { field: input.field } : {}),
        code: input.code,
        message: fillTemplate(input.template, input.params ?? {}),
        template: input.template,
        ...(hasMarkers && input.params ? { params: input.params } : {}),
    };
}
