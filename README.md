# Lost & Found — KBTU

A campus lost-and-found platform for KBTU students. Finders publish items with a location, category and discovery time. Students search the listings and contact the finder to arrange a handover.

The repository contains an ASP.NET Core API and an Angular frontend. PostgreSQL stores item listings; MongoDB stores conversations and messages.

## Features and status

| Feature | Status |
| --- | --- |
| University authentication | Entra ID support; development sign-in available locally |
| Found-item listings | Create, browse and view details |
| Search API | Combined category, cabinet and time filters; pagination |
| Returned items | Finder can mark an item returned; excluded from default search |
| Photos | One JPEG or PNG per listing, up to 5 MB |
| Chat API | Two-person conversations, persistent history and duplicate-send protection |
| Unread messages | Per-conversation counts and explicit read acknowledgement |
| Live delivery | Native WebSocket with short-lived, single-use connection tickets |
| Angular chat integration | Chat list, unread badges, live thread over WebSocket with reconnect and history catch-up |

Saved searches and alerts in the frontend are local demo features, not backend notification services.

## Stack

- C#, .NET 10, ASP.NET Core Web API
- Entity Framework Core and PostgreSQL 17
- MongoDB 8 and MongoDB.Driver
- Native WebSocket; no SignalR
- Angular 22, TypeScript, SCSS and Microsoft MSAL
- Docker Compose and GitHub Actions

RabbitMQ is not currently used.

## Local setup

### Requirements

- .NET 10 SDK
- Node.js 24 (see `lost-found-frontend/.nvmrc`) and npm
- Docker with Docker Compose
- Git

### 1. Clone and start databases

```bash
git clone https://github.com/tamirlanm/lost-found.git
cd lost-found
docker compose up -d
```

Compose starts PostgreSQL on `localhost:5433` and MongoDB on `localhost:27018`. It does not start the API or frontend. Database data is retained in named volumes.

### 2. Start the API

For use with the Angular development proxy:

```bash
dotnet run --project src/LostAndFound.Api --launch-profile http
```

API: `http://localhost:5043`.

For HTTPS testing in Postman, stop the HTTP run and use:

```bash
dotnet dev-certs https --trust
dotnet run --project src/LostAndFound.Api --launch-profile https
```

HTTPS API: `https://localhost:7117`. This profile also opens HTTP port 5043; prefer the HTTP-only profile for the current Angular proxy configuration.

In Development, PostgreSQL migrations run automatically unless `Database:MigrateOnStartup` is disabled. MongoDB chat indexes are created at startup. Both databases must be available before starting the API.

### 3. Start the frontend

In another terminal, from the repository root:

```bash
cd lost-found-frontend
npm ci
npm start
```

Open `http://localhost:4200`. The development proxy forwards `/api` requests to `http://localhost:5043`.

## Authentication and configuration

Local defaults are in `src/LostAndFound.Api/appsettings.Development.json`. The frontend development settings are in `lost-found-frontend/src/environments/environment.development.ts`.

In local Dev mode, requests identify the user with a header:

```http
X-Dev-User: finder@kbtu.kz
```

Use a different email, such as `seeker@kbtu.kz`, to test a second participant. Dev mode is only permitted in the Development environment.

Production uses Microsoft Entra ID access tokens:

```http
Authorization: Bearer <access-token>
```

The API requires the `access_as_user` scope. Configure the SPA registration, API registration, redirect URIs and exposed scope for your deployment.

| Environment variable | Purpose |
| --- | --- |
| `ConnectionStrings__Postgres` | PostgreSQL connection string |
| `MongoDb__ConnectionString` | MongoDB connection string |
| `MongoDb__DatabaseName` | MongoDB database name |
| `Auth__Mode` | `Entra` for production; `Dev` for local development |
| `Auth__AllowedEmailDomain` | Set to `kbtu.kz` to enforce the email-domain restriction |
| `AzureAd__Instance` | Microsoft identity authority base URL |
| `AzureAd__TenantId` | Entra tenant ID |
| `AzureAd__ClientId` | API application client ID |

Supply production configuration through environment variables or your deployment's secret-management system. The checked-in database credentials are local development defaults.

## API overview

Item and chat endpoints require authentication, except that the WebSocket upgrade authenticates using its one-time ticket.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | Application liveness; does not check database readiness |
| GET | `/api/me` | Current user |
| POST | `/api/items` | Create a found-item listing |
| GET | `/api/items` | Filter and paginate listings |
| GET | `/api/items/{id}` | Get a listing by UUID; numeric listing numbers are also supported |
| PATCH | `/api/items/{id}/returned` | Mark your listing returned |
| POST | `/api/items/{id}/photo` | Upload one photo as multipart form field `photo` |
| GET | `/api/items/{id}/photo` | Retrieve a listing photo |
| POST | `/api/conversations` | Create or reopen a conversation for a listing |
| GET | `/api/conversations` | List your conversations and unread counts |
| POST | `/api/conversations/{id}/messages` | Send a message |
| GET | `/api/conversations/{id}/messages` | Read paginated history |
| POST | `/api/conversations/{id}/read` | Mark received messages read |
| POST | `/api/conversations/{id}/ws-ticket` | Issue a connection ticket |
| GET | `/api/conversations/{id}/ws` | Upgrade to WebSocket |

Development OpenAPI JSON: `/openapi/v1.json`. A Swagger UI is not configured.

### Search

```http
GET /api/items?cabinet=214&category=Electronics&period=Last7Days&page=1&pageSize=20
```

Filters combine with AND. Supported periods are `Today`, `Last7Days` and `Last30Days`. Today starts at midnight UTC+5; the other periods are rolling windows based on the time found. Results are ordered by listing creation time, newest first.

The default search includes only Open listings. Use `status=Returned` to select returned listings. `mine=true` includes your listings across statuses unless an explicit status is supplied.

Category values for JSON request bodies:

| Value | Category |
| --- | --- |
| 0 | Accessory |
| 1 | Clothing |
| 2 | Electronics |
| 3 | Documents |
| 4 | Keys |
| 5 | Other |
| 6 | Bottles |
| 7 | BooksAndNotes |

### Chat requests

Create a conversation:

```http
POST /api/conversations
Content-Type: application/json

{"foundItemId":"<listing-uuid>"}
```

Send a message:

```http
POST /api/conversations/{id}/messages
Content-Type: application/json

{"clientMessageId":"<new-uuid>","text":"Does it have a blue sticker?"}
```

Messages support up to 4,000 characters. Generate a new `clientMessageId` for each new message; reuse it when retrying the same send. A new message returns 201, a retry returns 200, and reusing the same ID for different text returns 409.

History returns the newest messages first. Use `limit` (1–100, default 30), then pass `nextBefore` as `before` to request older messages. A null `nextBefore` means there are no more pages.

Mark displayed incoming messages read:

```http
POST /api/conversations/{id}/read
Content-Type: application/json

{"messageIds":["<message-id>"]}
```

Use the message's `id`, not `senderUserId` or `clientMessageId`. Up to 100 IDs can be acknowledged per request. A 204 response does not guarantee a count changed: unknown IDs, own messages and already-read messages do not reduce the unread count.

## WebSocket flow

1. As a conversation participant, request `POST /api/conversations/{id}/ws-ticket` using normal authentication.
2. Within 30 seconds, connect to `wss://<host>/api/conversations/{id}/ws?ticket=<ticket>`; use `ws://` for local HTTP.
3. Wait for `{"type":"ready"}`. Send messages through the HTTP endpoint; live events arrive as `{"type":"message","message":{...}}`.
4. After ready, load history and merge it with live events by message ID to avoid duplicates.
5. After a disconnect, obtain a new ticket, reconnect with backoff, and reload history. For complete recovery, paginate history and merge by ID; the socket does not automatically replay offline messages.

The socket streams one conversation. Refresh the conversation list to update unread counts for other conversations. Do not send application messages into this socket; the current receive loop closes on such frames.

Connection tickets and event subscriptions are stored in memory. Run one API instance; multiple instances require shared ticket storage and cross-instance event distribution. Connections have a one-hour lifetime. Slow clients may be disconnected and must recover from persisted history. Live broadcasts are best-effort; MongoDB history is the durable source.

## Deployment

The backend GitHub Actions workflow builds an ARM64 image, pushes it to GHCR and invokes the server's deploy command over SSH. It requires `DEPLOY_HOST`, `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS` repository secrets and the corresponding server setup.

The Docker image includes `/app/migrations.sql`; production deployment must apply the SQL separately. Persist `/app/App_Data/photos` in a writable volume when running the API container, and back it up along with both databases.

The reverse proxy must support WebSocket upgrades and appropriate idle timeouts. Do not log the ticket query string. The Angular development proxy forwards WebSocket upgrades (`"ws": true` in `proxy.conf.json`).

## Development commands

```bash
# From the repository root
dotnet build src/LostAndFound.Api

# From lost-found-frontend/
npm run build
npm run test:ci
```

The repository currently has no backend automated test project. Manual Postman checks cover sending messages, live delivery and fetching messages sent while disconnected; full browser integration and public deployment acceptance remain separate checks.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/LostAndFound.Api/Features/Items/` | Listings, search, returned status and photos |
| `src/LostAndFound.Api/Features/Chat/` | Conversations, messages, read state and WebSocket |
| `src/LostAndFound.Api/Features/Identity/` | User identity and development authentication |
| `src/LostAndFound.Api/Infrastructure/` | EF Core, MongoDB indexes and local photo storage |
| `lost-found-frontend/` | Angular application |
| `.github/workflows/` | Build and deployment workflows |
| `docker-compose.yml` | Local PostgreSQL and MongoDB services |

See the [frontend README](lost-found-frontend/README.md) for UI setup. Its chat/demo descriptions refer to local frontend behavior; use this README for the backend chat contract.
