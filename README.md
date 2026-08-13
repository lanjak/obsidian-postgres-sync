# Postgres Sync

Sync your Obsidian vault across devices using a self-hosted Postgres database instead of Obsidian Sync, iCloud, or a CouchDB setup. Every note also gets embedded, so the same table doubles as a semantic search index you can query from outside Obsidian.

## What you need

- A Postgres instance (with the `pgvector` extension available) reachable from every device you want to sync, fronted by [PostgREST](https://postgrest.org/) - Obsidian mobile can't open a raw database connection, so PostgREST is what actually speaks HTTP to the plugin.
- An embedding server that speaks the llama.cpp `/embedding` endpoint, also reachable from every device. Point it at any embedding model you like; 768-dim models are the default assumption in `sql/schema.sql`, but you can change the `embedding` column's dimension to match whatever you run (do this before first use - see the comment in that file).
- The schema in `sql/schema.sql` applied to your Postgres database, with a real API key set in `app_settings.bearer_token`, and PostgREST configured to use it (see below).

Obsidian Sync, CouchDB, Syncthing - none of that is needed. This plugin talks to PostgREST directly from inside Obsidian, so it works on desktop and mobile. Use HTTPS when either service is reachable outside a trusted private network. HTTP exposes note content and API keys in transit.

## Setting up the backend

1. Create a Postgres database and run `sql/schema.sql` against it:
   ```bash
   psql "postgres://user:pass@your-host:5432/your-db" -f sql/schema.sql
   ```
2. Set a real API key (the seeded default is `change-me`, don't leave it) and a login password for the `authenticator` role:
   ```sql
   update app_settings set bearer_token = 'a long random key of your choosing';
   alter role authenticator with login password 'a real password';
   ```
3. Run PostgREST pointed at the same database, connecting as `authenticator`, with:
   - `db-anon-role = web_anon`
   - `db-pre-request = public.check_bearer_token`

   The plugin sends its key as an `X-Api-Key` header, not `Authorization` - PostgREST reserves `Authorization` for its own JWT handling, so a custom header is what `check_bearer_token()` actually checks.

   Don't set PostgREST's `max-rows` below 100, or the plugin's pull (which pages in batches of 100) will silently stop early.

### Upgrade an existing backend to 0.1.1

Version 0.1.1 needs the server revision column in [`sql/migrations/0.1.1-sync-revision.sql`](https://github.com/lanjak/obsidian-postgres-sync/blob/0.1.1/sql/migrations/0.1.1-sync-revision.sql). Apply this migration before you install the 0.1.1 plugin on any device.

Stop PostgREST and schedule a short maintenance window. The migration backfills existing rows and builds an index, so it can block reads and writes while it runs. Apply it as the Postgres owner, then start PostgREST again:

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f sql/migrations/0.1.1-sync-revision.sql
```

## Install the plugin

Manually:

1. Download `main.js` and `manifest.json` from the latest release.
2. Drop them into `<your vault>/.obsidian/plugins/postgres-sync/`.
3. Enable community plugins in Obsidian, then enable "Postgres Sync".

## Setup

Open the plugin settings and fill in:

- **PostgREST URL** - your PostgREST instance's address.
- **API key** - the key you set in `app_settings.bearer_token`.
- **Embedding server URL** - your llama.cpp embedding server's address.
- **Embed API key** - optional, only needed if your embedding server requires auth.

Do this on every device you want synced, pointing at the same PostgREST instance. The plugin pulls remote notes and reconciles existing local notes when it starts. You can also run the "Pull changes from Postgres now" command.

## How sync works, briefly

Last-write-wins by modification time. No conflict resolution beyond that, so if you edit the same note offline on two devices at once, whichever save lands later wins. Fine for a single person across a few devices; not built for real-time collaborative editing.

Uploads run one at a time to protect mobile devices and local embedding servers. New edits take priority over background recovery. Failed uploads retry with capped backoff, and Obsidian shows one aggregate failure notice instead of one notice per file. Embedding input is bounded for common local-model context limits, but Postgres always stores the complete note.

Android and iOS normally use case-insensitive storage. If the database contains paths that differ only by letter case, such as `TODO.md` and `Todo.md`, mobile keeps the existing path, reports the conflict once, and continues syncing other notes.

## License

MIT
