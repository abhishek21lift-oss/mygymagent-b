# P0 Verification Checklist

## Backend
- [ ] npm ci
- [ ] prisma generate
- [ ] typecheck
- [ ] unit tests
- [ ] production build
- [ ] migration deploy against a disposable PostgreSQL instance
- [ ] `/health` returns 200
- [ ] `/ready` returns 200 with DB + Redis available
- [ ] auth refresh cookie is secure/httpOnly in production
- [ ] credentialed CORS only allows configured origins
- [ ] tenant-isolation tests pass for organization, branch and trainer-assignment scopes
- [ ] AI tool authorization tests pass

## Frontend
- [ ] npm ci
- [ ] typecheck
- [ ] lint
- [ ] production build with explicit API URL
- [ ] no production client path resolves API URL to localhost
- [ ] auth refresh works against production API origin
- [ ] browser requests include credentials where required

## VPS
- [ ] Existing MyPTStudio containers remain healthy
- [ ] MyGymAgent containers use isolated names/network
- [ ] PostgreSQL/Redis are not publicly exposed unless deliberately required
- [ ] Nginx routes only after a domain exists
- [ ] TLS certificate installed after DNS is configured
- [ ] backups and restore procedure documented
- [ ] deployment rollback procedure documented

Do not mark P0 complete from source inspection alone. Record actual command/test results before closing the milestone.
