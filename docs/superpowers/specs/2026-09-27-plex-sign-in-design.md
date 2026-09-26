# Plex Sign-In Design

## Purpose

Recomendarr will let a user connect Plex by signing in through Plex's hosted authorization page instead of manually finding and pasting a token. The resulting connection must provide the same server access Recomendarr currently uses for connection checks, library sections, watched history, metadata, genres, and posters. Manual Plex URL and token entry remains available as an advanced fallback.

## User experience

When Plex is selected in setup or Settings, the primary action is **Sign in with Plex**. Recomendarr creates a time-limited Plex PIN and opens Plex's hosted sign-in page in a new browser tab. The Recomendarr page polls its own API until the PIN is claimed, expires, or is cancelled.

After authorization, Recomendarr retrieves the Plex Media Servers available to that account. If one server is available, it is selected automatically. If several are available, the user chooses one by name. The UI then shows the connected account state and selected server, with actions to change server, reconnect, or disconnect.

Manual configuration remains under an **Advanced manual setup** control. It retains the existing server URL and Plex token fields and continues to work without Plex-hosted sign-in.

## Authentication and server discovery

Recomendarr generates one random Plex client identifier per installation and persists it in the existing settings store. It reuses that value for all Plex API requests so Plex represents the installation as one authorized device. Requests identify the product as `Recomendarr` and include a version and platform/device description where appropriate.

The server creates a strong PIN with Plex and returns only the PIN identifier, code, expiry information, and hosted authorization URL to the browser. The browser never receives a Plex access token.

The browser polls a Recomendarr endpoint with the PIN identifier and code. Recomendarr checks the PIN with Plex. Until claimed, it returns a pending state. When claimed, the server uses the returned account token to request `https://clients.plex.tv/api/v2/resources` with HTTPS, relay, and IPv6 connections included.

Each discovered Plex Media Server is normalized to a small server choice containing its stable client identifier, display name, ownership/shared status, availability, and usable connection candidates. The account token and resource-specific server tokens remain server-side.

Connection choice order is:

1. Reachable local HTTPS connection.
2. Reachable non-local HTTPS connection.
3. Reachable local HTTP connection.
4. Reachable non-local HTTP connection.
5. Plex relay connection as a last resort.

Recomendarr verifies candidates against the Plex server root endpoint and requires a `MediaContainer` response. Discovery may return the candidate list before all endpoints are tested, but saving a server must validate the selected URL and token.

For a selected resource, Recomendarr stores the resource-specific `accessToken` as the media server API key, the chosen connection URI as the media server URL, and the resource client identifier/name for display and future reconnection. The existing Plex connector continues using `X-Plex-Token`; no separate downstream authentication path is introduced.

## API boundaries

A focused Plex authentication module owns calls to Plex's PIN, user-validation, and resource-discovery endpoints. It accepts an injectable HTTP client so tests can validate request headers and responses without contacting Plex.

Recomendarr exposes server-side routes for:

- Starting sign-in and returning the hosted Plex authorization URL.
- Polling a PIN and returning `pending`, `expired`, or a list of server choices.
- Selecting and validating a discovered server, then persisting its URL and token.
- Disconnecting Plex by clearing stored Plex credentials and display metadata.

The polling response uses an opaque, short-lived server-side pending-auth record rather than returning account or server tokens. Pending records expire with the Plex PIN and are deleted after successful selection, cancellation, or expiry. Because this application runs as one self-hosted process, these transient records may live in an in-memory map; restarting during sign-in requires the user to start again and does not affect an established connection.

All route inputs are validated. PIN identifiers and selection identifiers must belong to a pending sign-in created by the same Recomendarr installation. Errors returned to the browser describe whether sign-in expired, Plex was unavailable, no server was found, or the selected server could not be reached, without exposing tokens or raw Plex payloads.

## Settings and secrets

The existing settings table stores:

- The installation Plex client identifier.
- The selected server URL and resource-specific access token using the existing media server settings.
- Selected Plex server identifier and display name.
- A non-secret account display label if Plex supplies one.

Settings APIs continue masking stored secrets. Neither the account token nor server token appears in JSON responses, application logs, browser state, query strings, or poster URLs generated for the browser. Poster access will be proxied through a Recomendarr server route or fetched through another server-side mechanism so the existing token is not exposed in image URLs.

Disconnect clears the selected server token, URL, and Plex display metadata. It cannot revoke the Plex authorized device remotely; the UI explains that complete revocation can also be performed in Plex account settings.

## Existing behavior and compatibility

The Plex connector keeps supporting manually configured credentials. Signed-in connections populate the same `media_server_url` and `media_server_api_key` values, so connection tests, watched-history synchronization, recommendation generation, and watched learning continue using the existing code path.

Jellyfin and Emby setup and settings are unchanged. Existing Plex installations with a manual token continue working and are shown as manually configured until the user chooses Plex sign-in.

If authorization is revoked or a stored token returns HTTP 401, Recomendarr reports that Plex needs to be reconnected. Other network or Plex errors do not erase a stored token automatically.

## Testing

Focused tests cover:

- Stable generation and reuse of the installation client identifier.
- Correct Plex headers and strong-PIN creation.
- Pending, claimed, expired, malformed, and upstream-error PIN responses.
- Tokens never appearing in API responses or logs.
- Resource parsing for owned and shared servers, multiple connections, missing tokens, and no available servers.
- Connection ordering and validation, including relay fallback.
- Saving the selected URL and resource token into the existing media-server configuration.
- Disconnect behavior and preservation of unrelated settings.
- Existing manual Plex configuration remaining functional.
- Settings and setup UI states for sign-in, polling, server selection, errors, reconnect, disconnect, and manual fallback.
- Existing Plex connector tests proving authenticated library/history/poster behavior still works.

The full `npm test`, `npm run lint`, and `npm run build` commands must pass before completion.

## Out of scope

- Collecting or storing a Plex username or password.
- Plex Home managed-user switching.
- Remote revocation of authorized devices.
- Changes to Jellyfin or Emby authentication.
- Changes to recommendation, Not now, Watched, Seerr, or watchlist behavior beyond consuming the same Plex history already supported.
