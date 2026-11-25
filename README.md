# SONIVA

**WhatsApp Sound Sticker Bot** powered by Baileys and FFmpeg.

SONIVA creates WhatsApp sound stickers from a video, or combines an image/video with a separate audio file. It also adds audio to an existing sticker.

## Commands

| Command | What it does |
| --- | --- |
| `.sticker` | Start creating a sound sticker |
| `.s`, `.sc`, `.stc`, `.stiker` | Aliases for `.sticker` |
| `.addaudio` | Add audio to the sticker being replied to |
| `.limit` | Check daily usage |
| `.cancel` | Cancel a media-waiting session |
| `.help` | Show the command list |\n| `.antilink on/off` | Toggle link moderation in a group (admins/owner) |\n| `.antibot on/off` | Toggle fail-safe bot-account moderation (admins/owner) |\n| `.antispam on/off` | Toggle repeated-message detection (admins/owner) |\n| `.welcome on/off` | Toggle new-member greetings (admins/owner) |\n| `.goodbye on/off` | Toggle member-leave messages (admins/owner) |

Commands can be sent as a media caption or as a text reply to the media.

## How the media flow works

- **Video with audio:** send the video with `.sticker`. SONIVA uses the video's audio track automatically.
- **Video without audio:** SONIVA detects the missing audio track and asks for a separate audio file.
- **Image:** send the image with `.sticker`; SONIVA asks for audio.
- **Audio first:** send audio with `.sticker`; SONIVA asks for an image or video.
- **Existing sticker:** reply to a normal sticker with `.addaudio`, then send the audio.

SONIVA keeps each waiting session separate by chat and sender. A session expires after the configured waiting period. Use `.cancel` to cancel it earlier.

## Group features\n\nGroup settings are stored in SQLite separately for each group. Only group admins or the configured owner can change them. The bot checks its own admin role before deleting messages or removing participants.\n\n- **Antilink:** removes messages containing external links, while allowing `saweria.co` and its subdomains so SONIVA's support link is not blocked. Group admins, the owner, and the bot itself are exempt. The bot must be a group admin to delete messages.\n- **Antispam:** detects the same text repeated four times within ten seconds. It does not automatically kick members.\n- **Antibot:** only removes a newly added participant when Baileys group metadata explicitly marks that participant with `isBot: true` or `bot: true`. WhatsApp does not expose a universal reliable bot flag, so unknown accounts are not kicked based on guesses. The bot itself, configured owner, and group admins are always protected.\n- **Welcome / goodbye:** sends a mention when members join or leave.\n\nMessage handling marks incoming messages as read, reacts with ⏳ while processing, then reacts with ✅ when the handler finishes. The bot advertises online presence after connecting. Saweria support is included in the help menu and high-quality link previews are enabled.\n\n## Usage limits

Default limits:

| Account | Daily creations |
| --- | ---: |
| Free | 5 |
| Premium | 50 |
| Owner | Unlimited |

A successful generation consumes one use. Failed conversions and failed sends do not consume a use. Usage and premium expiry are stored in a local SQLite database.

Owner-only premium management:

- `.premium add 628xxxxxxxxxx 30` — grant 30 days (30 is the default).
- `.premium remove 628xxxxxxxxxx` — remove premium.
- `.premium list` — list active premium users.

The owner number is configured locally through `SONIVA_OWNER`; it is never hardcoded into the source code. Premium durations can be set from 1 to 3650 days.

## Requirements

- Node.js **22.13 or newer** (the project uses the built-in `node:sqlite` module).
- FFmpeg and FFprobe with the `libwebp` and `libopus` encoders.
- A WhatsApp account that can be linked as a companion device.

No paid API key or third-party media API is used.

## Install on Termux

~~~bash
pkg update
pkg install nodejs ffmpeg git
git clone https://github.com/irhsrykhan01/SONIVA.git
cd SONIVA
npm install
cp .env.example .env
nano .env
~~~

Set your owner number in `.env`:

~~~env
SONIVA_OWNER=628xxxxxxxxxx
~~~

Then start SONIVA:

~~~bash
npm start
~~~

Scan the QR code using **WhatsApp → Linked devices → Link a device**. The login is stored locally in `auth_info/`; subsequent starts reuse the saved session.

Before starting, SONIVA checks that FFmpeg and FFprobe are installed and that both required encoders are available.

## Install on Linux

Install Node.js 22.13+, FFmpeg, and Git using your distribution's package manager. Then run:

~~~bash
git clone https://github.com/irhsrykhan01/SONIVA.git
cd SONIVA
npm install
cp .env.example .env
~~~

Edit `.env`, set `SONIVA_OWNER`, and run `npm start`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `SONIVA_OWNER` | empty | Owner phone number, country code included, digits only |
| `FREE_DAILY_LIMIT` | `5` | Daily limit for free users |
| `PREMIUM_DAILY_LIMIT` | `50` | Daily limit for premium users |
| `MAX_MEDIA_MB` | `64` | Maximum downloaded source file size |
| `MAX_STICKER_SECONDS` | `10` | Maximum animation/audio duration |
| `MAX_STICKER_BYTES` | `500000` | Maximum animated WebP size |
| `AUDIO_BITRATE` | `32k` | Opus output bitrate |
| `MAX_PENDING_MINUTES` | `8` | How long SONIVA waits for the next media item |
| `TIME_ZONE` | `Asia/Jakarta` | Time zone used for daily limit reset |
| `AUTH_DIR` | `auth_info` | Local Baileys credentials folder |
| `DATABASE_PATH` | `.data/soniva.sqlite` | Local SQLite database path |
| `PAIRING_NUMBER` | empty | Optional phone number for pairing-code login |

Do not upload `.env`, `auth_info/`, or the `.data/` database to GitHub. They contain private account/configuration data.

## How Sound Sticker sending works

A Sound Sticker is not sent as two unrelated chat messages. SONIVA uploads the animated WebP and the Ogg/Opus audio, creates the audio-message metadata, and embeds that metadata in the sticker protobuf message. In the WhatsApp message schema researched for this project, the embedded audio is field **26** of `StickerMessage`.

The pinned Baileys build does not expose this extension as a normal high-level send option. SONIVA therefore adds a narrowly scoped encoder/decoder compatibility layer for that field and verifies that the outgoing sticker protobuf contains it before relaying the message.

The media pipeline:

1. Probes the source with FFprobe to identify video/audio streams.
2. Produces a 512×512 animated WebP, keeping it within the configured sticker-size limit.
3. Converts the chosen audio track to Ogg/Opus and trims it to the animation duration.
4. Uploads both media assets through Baileys.
5. Embeds the uploaded audio metadata into the sticker message and sends one Sound Sticker message.

The protocol is unofficial and may change. The Sound Sticker feature is being rolled out gradually by WhatsApp, so playback depends on the recipient's WhatsApp version and account availability. SONIVA does not create sticker packs; the feature is sent as an individual chat message.

## Privacy and account safety

- Source media and generated files are held in a temporary directory and deleted after processing.
- WhatsApp credentials and usage data stay on the machine running SONIVA.
- The bot does not send media to a paid conversion API.
- Use only media you have permission to process and share.
- Baileys is an unofficial WhatsApp Web client. Automated use may be restricted by WhatsApp and can put the linked account at risk. Consider testing with a secondary account and do not use the bot for bulk messaging or spam.

## Tests

~~~bash
npm run check
npm test
~~~

The automated tests cover command parsing, media classification, quoted-message routing, owner identification, protobuf field extraction, daily quotas, and premium expiry. They do not replace an end-to-end test with a WhatsApp account that has Sound Sticker playback enabled.

## Project status

**Early implementation / compatibility testing.** The code includes the planned command flows, media conversion, database-backed limits, and the Sound Sticker protobuf extension. Real-world delivery and playback must still be validated with a linked WhatsApp test account; WhatsApp's gradual rollout means that not every recipient can play Sound Stickers yet.

## License

MIT
