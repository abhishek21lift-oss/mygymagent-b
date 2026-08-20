# API conventions

## Response envelope

Every successful response is wrapped by `ResponseInterceptor`
(`src/common/interceptors/response.interceptor.ts`):

```json
{
  "data": { "...": "the actual payload" },
  "meta": { "requestId": "..." }
}
```

Every error response is shaped by `AllExceptionsFilter`
(`src/common/filters/all-exceptions.filter.ts`):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable summary",
    "details": { "...": "optional, e.g. per-field validation errors" },
    "requestId": "..."
  }
}
```

- `requestId` is set by `RequestIdMiddleware` from the incoming `X-Request-Id` header if present
  (capped at 128 chars) or a generated UUID otherwise, echoed back in the `X-Request-Id` response
  header and in every error/success envelope — the one value you need to correlate a client bug
  report with server logs.
- 5xx errors are logged server-side with the full stack trace; the client never receives a stack
  trace, raw SQL, table names, or any other internal detail — `AllExceptionsFilter` translates known
  error types (validation, Prisma unique-constraint `P2002` → `409 CONFLICT`, Prisma not-found
  `P2025` → `404 NOT_FOUND`) to safe codes and falls back to a generic `500 INTERNAL_SERVER_ERROR`
  for anything unrecognized.

## Pagination

Offset-based, via `PaginationQueryDto`/`paginate()`/`skipTake()`
(`src/common/dto/pagination-query.dto.ts`): list endpoints accept `?page=1&pageSize=20` query
params and return `{ items, total, page, pageSize }` inside the `data` envelope. Cursor-based
pagination isn't needed yet at current data volumes but is the natural upgrade path for
high-cardinality tables (`Attendance`, `AuditLog`) once offset pagination's `COUNT(*)` cost becomes
a problem — see `docs/testing/strategy.md`'s performance-gate notes.

## Auth

- `Authorization: Bearer <access token>` header for the JWT access token, OR the `httpOnly` refresh
  cookie for `/auth/refresh` — see ADR 0002.
- Routes are protected by default; `@Public()` opts a route out (used only by `/health`, `/ready`,
  and the pre-login auth endpoints themselves).
- Permission-gated routes use `@RequirePermission('resource.action')` — see
  `docs/security/overview.md`.

## Validation

`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` globally: any
field not declared on the DTO is **rejected** (400), not silently dropped — this is what makes
tenant-isolation enforcement structural rather than a convention (see ADR 0001): a client cannot
even attempt to set `organizationId` on a create/update body.

## Versioning

Not yet needed — there's exactly one consumer (the `mygymagent-f` frontend) deployed in lockstep
with the backend. If/when a public API or a mobile client is added, version via a URL prefix
(`/v1/...`) rather than a header — simpler to reason about, easier to route/observe.

## Keeping frontend and backend in sync

Per ADR 0005, there is no shared, compiled type package between the two repos today. Discipline
required on every backend response-shape change:

1. Change the backend DTO/response type.
2. Grep the frontend for the corresponding type in `src/lib/types/*.ts` and its usages, update both.
3. Update `src/lib/validation/*.ts` zod schemas if the shape affects a form.
4. Run the frontend typecheck (`npm run typecheck`) — a shape mismatch in a `fetch` call's assumed
   response type won't be caught by TypeScript unless the API client function's return type is
   updated too, since `fetch` itself is untyped. This is exactly the risk ADR 0005 accepted; the
   fix once it becomes painful is generated types from an OpenAPI spec (e.g. `@nestjs/swagger` +
   `openapi-typescript`), not a monorepo merge.

## HTTP status conventions

| Situation | Status |
|---|---|
| Success (read or write) | `200` / `201` (create) |
| Validation failure, or a client-supplied field the server refuses (e.g. injected `organizationId`) | `400` |
| Not authenticated / expired or invalid token | `401` |
| Authenticated but lacking the required permission | `403` |
| Resource doesn't exist **in the caller's tenant** (a cross-tenant read looks identical to a truly missing resource — see ADR 0001) | `404` |
| Unique-constraint violation (e.g. duplicate `memberCode`) | `409` |
| Rate limit exceeded | `429` |
| Unhandled server error | `500` |
| Dependency (DB) unreachable — `/ready` only | `503` |
