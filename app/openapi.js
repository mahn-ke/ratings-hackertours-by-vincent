const text = (maxLength, description) => ({ type: 'string', maxLength, ...(description && { description }) });
const nullable = schema => ({ ...schema, nullable: true });
const id = { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$', description: 'Client-generated idempotency key, unique per platform; keep it across retries.' };
const score = description => nullable({ type: 'integer', minimum: 1, maximum: 5, description });
const platform = { type: 'string', enum: ['3ds', 'xbox', 'switch', 'gba'], description: 'From the token\'s azp, never from the body.' };
const submission = {
    type: 'object', additionalProperties: false,
    required: ['id', 'time', 'session', 'organizer', 'event', 'item_id', 'tour', 'lang', 'content', 'guide', 'duration', 'game_title_id', 'game_name', 'game_type', 'build'],
    properties: {
        id,
        time: { type: 'integer', minimum: 0, description: 'Unix seconds of the rating on the console\'s clock.' },
        session: nullable(text(64, 'The console\'s session of the tour, if it has one.')),
        organizer: text(64, 'The shop\'s organizer slug.'),
        event: text(64, 'The shop\'s event slug.'),
        item_id: { type: 'integer', minimum: 0, description: 'The shop item (tour) id.' },
        tour: text(200, 'The tour\'s title as shown.'),
        lang: { type: 'string', enum: ['en', 'de'], description: 'The language the guest rated in.' },
        content: score('Stars for the tour\'s content; null when skipped.'),
        guide: score('Stars for the guide; null when skipped.'),
        duration: nullable({ type: 'string', enum: ['way_too_short', 'too_short', 'perfect', 'too_long', 'way_too_long'], description: 'Null when skipped.' }),
        game_title_id: nullable(text(32, 'The game played on the console during the tour, if any.')),
        game_name: nullable(text(200)),
        game_type: nullable({ type: 'string', enum: ['disc', 'arcade', 'gba'] }),
        build: text(64, 'The console app\'s build.'),
    },
};
const rating = {
    type: 'object', additionalProperties: false, required: ['platform', ...submission.required],
    properties: { platform, ...submission.properties },
};
const drawing = {
    type: 'object', additionalProperties: false, required: ['platform', 'id', 'bytes'],
    properties: { platform, id, bytes: { type: 'integer', minimum: 9, maximum: 65536 } },
};
const json = schema => ({ 'application/json': { schema } });
const response = (description, schema) => ({ description, content: json(schema) });
const error = { type: 'object', required: ['error'], properties: { error: { type: 'string' } } };
const authErrors = {
    401: { ...response('Missing, invalid or expired access token', error), headers: { 'WWW-Authenticate': { schema: { type: 'string' } } } },
    403: response('Token client is not allowed', error),
    429: { ...response('Client quota exhausted', error), headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until the next minute.' } } },
};
const authDescription = 'Keycloak RS256 access token with issuer, exp, iat, sub and an allowed azp (the consoles\' service accounts of the high scores). 120 requests per client per minute, shared by both operations.';

export const openapi = {
    openapi: '3.0.3',
    info: { title: 'Hackertours Tour Ratings API', version: '1.0.0', description: 'Tour ratings from the Nintendo 3DS, Xbox 360, Nintendo Switch and Game Boy Advance (through its link server). Write-only: the ratings are for the team, there is no public read API.' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas: { Submission: submission, Rating: rating, Drawing: drawing } },
    paths: {
        '/healthz': { get: { operationId: 'getHealth', summary: 'Check the service and database', responses: { 200: response('Healthy', { type: 'object', properties: { status: { type: 'string', enum: ['ok'] } } }) } } },
        '/api/ratings': { post: {
            operationId: 'submitRating', summary: 'Submit a rating', security: [{ bearer: [] }],
            description: `${authDescription} Send application/json, at most 4096 bytes, with exactly the documented fields (unknown or missing ones are rejected). A known (platform, id) returns the stored row unchanged, even if the submitted fields differ.`,
            requestBody: { required: true, content: json(submission) },
            responses: {
                200: response('Idempotent retry; the stored rating', rating), 201: response('Rating stored', rating),
                400: response('Malformed JSON, invalid, unknown or missing fields, wrong content type, or oversized body', error),
                ...authErrors,
            },
        } },
        '/api/ratings/{id}/drawing': { put: {
            operationId: 'putDrawing', summary: 'Attach the guest\'s drawing to a rating', security: [{ bearer: [] }],
            description: `${authDescription} Send image/png, at most 65536 bytes, starting with the PNG signature, after the rating itself was stored. A different drawing replaces the stored one (200); the same bytes again change nothing (200).`,
            parameters: [{ name: 'id', in: 'path', required: true, schema: id, description: 'The rating\'s id, of the token\'s platform.' }],
            requestBody: { required: true, content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
            responses: {
                200: response('Drawing already stored with these bytes, or replaced', drawing), 201: response('Drawing stored', drawing),
                400: response('Invalid id, wrong content type, not a PNG, or oversized body', error),
                404: response('No rating with this id from this platform', error),
                ...authErrors,
            },
        } },
    },
};
