'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function run(binary, args, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let finished = false;
        const timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            child.kill('SIGKILL');
            reject(new Error(binary + ' timed out after ' + Math.round(timeoutMs / 1000) + ' seconds.'));
        }, timeoutMs);
        timer.unref?.();
        child.stdout.on('data', chunk => { if (stdout.length < 2 * 1024 * 1024) stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { if (stderr.length < 2 * 1024 * 1024) stderr += chunk.toString(); });
        child.once('error', error => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            reject(error.code === 'ENOENT'
                ? new Error(binary + ' was not found. Install FFmpeg and make sure it is available in PATH.')
                : error);
        });
        child.once('close', code => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (code === 0) return resolve({ stdout, stderr });
            const detail = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
            reject(new Error(binary + ' exited with code ' + code + (detail ? ': ' + detail : '.')));
        });
    });
}

async function assertMediaTools() {
    await run('ffmpeg', ['-hide_banner', '-version'], 15000);
    await run('ffprobe', ['-hide_banner', '-version'], 15000);
    const encoders = await run('ffmpeg', ['-hide_banner', '-encoders'], 20000);
    if (!/\blibwebp\b/.test(encoders.stdout)) throw new Error('FFmpeg is missing the libwebp encoder.');
    if (!/\blibopus\b/.test(encoders.stdout)) throw new Error('FFmpeg is missing the libopus encoder.');
    return true;
}

function parseRate(value) {
    if (!value || value === '0/0') return 0;
    const [a, b] = String(value).split('/').map(Number);
    const rate = b ? a / b : a;
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

async function probeMedia(filePath) {
    const result = await run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type,codec_name,duration,width,height,channels,sample_rate,avg_frame_rate,r_frame_rate,start_time',
        '-of', 'json', filePath
    ], 30000);
    let parsed;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new Error('FFprobe returned invalid media information.'); }

    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const audio = streams.find(stream => stream.codec_type === 'audio') || null;
    const video = streams.find(stream => stream.codec_type === 'video') || null;
    const formatDuration = Number.parseFloat(parsed.format?.duration) || 0;
    const audioDuration = Number.parseFloat(audio?.duration) || formatDuration;
    const videoDuration = Number.parseFloat(video?.duration) || formatDuration;
    const fps = video ? (parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate)) : 0;
    return {
        streams, audio, video,
        hasAudio: Boolean(audio && Number(audio.channels || 1) > 0),
        formatDuration, audioDuration, videoDuration, fps
    };
}

const STICKER_PACK_NAME = 'Soniva Bot';
const STICKER_PACK_PUBLISHER = 'https://chat.whatsapp.com/Gu1elb8PoTJJp59RHpfvPp?s=cl&p=a&iam=2';

function buildStickerExif(packname = STICKER_PACK_NAME, publisher = STICKER_PACK_PUBLISHER) {
    const data = JSON.stringify({
        'sticker-pack-id': 'com.soniva.sticker',
        'sticker-pack-name': String(packname).slice(0, 100),
        'sticker-pack-publisher': String(publisher).slice(0, 100),
        'emojis': [],
        'android-app-store-link': '',
        'ios-app-store-link': '',
        'website': ''
    });
    const json = Buffer.from(data, 'utf8');
    const header = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    const exif = Buffer.concat([header, json]);
    exif.writeUInt32LE(json.length, 14);
    return exif;
}

function addStickerExif(webpBuffer, packname, publisher) {
    const input = Buffer.from(webpBuffer);
    if (input.length < 20 || input.toString('ascii', 0, 4) !== 'RIFF' ||
        input.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Error('Generated sticker is not a valid RIFF/WebP file.');
    }

    const chunks = [];
    let offset = 12;
    let hasExtendedHeader = false;
    while (offset + 8 <= input.length) {
        const type = input.toString('ascii', offset, offset + 4);
        const size = input.readUInt32LE(offset + 4);
        const dataStart = offset + 8;
        const dataEnd = dataStart + size;
        const chunkEnd = dataEnd + (size & 1);
        if (dataEnd > input.length || chunkEnd > input.length) {
            throw new Error('Generated WebP contains a truncated chunk.');
        }
        if (type === 'VP8X') {
            if (size < 10) throw new Error('Generated WebP has an invalid VP8X header.');
            const chunk = Buffer.from(input.subarray(offset, chunkEnd));
            chunk[dataStart - offset] |= 0x08;
            chunks.push(chunk);
            hasExtendedHeader = true;
        } else if (type !== 'EXIF') {
            chunks.push(Buffer.from(input.subarray(offset, chunkEnd)));
        }
        offset = chunkEnd;
    }
    if (offset !== input.length) throw new Error('Generated WebP has invalid chunk alignment.');
    if (!hasExtendedHeader) {
        throw new Error('Generated WebP has no VP8X metadata header; cannot safely attach sticker attribution.');
    }

    const exif = buildStickerExif(packname, publisher);
    const exifChunk = Buffer.alloc(8 + exif.length + (exif.length & 1));
    exifChunk.write('EXIF', 0, 'ascii');
    exifChunk.writeUInt32LE(exif.length, 4);
    exif.copy(exifChunk, 8);
    const body = Buffer.concat([...chunks, exifChunk]);
    const output = Buffer.alloc(12 + body.length);
    output.write('RIFF', 0, 'ascii');
    output.writeUInt32LE(body.length + 4, 4);
    output.write('WEBP', 8, 'ascii');
    body.copy(output, 12);
    return output;
}

function addStickerExifFile(filePath) {
    const original = fs.readFileSync(filePath);
    const updated = addStickerExif(original);
    fs.writeFileSync(filePath, updated);
    return updated.length;
}

const VIDEO_LADDER = Object.freeze([
    [15, 60, 512],
    [12, 50, 512],
    [10, 45, 448],
    [10, 35, 384],
    [8, 30, 320],
    [6, 25, 256],
    [5, 20, 192]
]);

const METADATA_RESERVE = 2048;
const MAX_SAMPLE_ENCODINGS = 3;
const MAX_FULL_ENCODINGS = 2;

function stickerFilter(fps, dimension) {
    return 'fps=' + fps +
        ',scale=' + dimension + ':' + dimension +
        ':force_original_aspect_ratio=decrease:flags=lanczos' +
        ',format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';
}

async function encodeWebpFile(inputPath, outputPath, fps, quality, dimension, duration, imageInput = false) {
    fs.rmSync(outputPath, { force: true });
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (imageInput) args.push('-loop', '1', '-framerate', String(fps), '-i', inputPath);
    else args.push('-i', inputPath);
    args.push(
        '-t', duration.toFixed(3),
        '-an', '-vf', stickerFilter(fps, dimension),
        '-fps_mode', 'cfr',
        '-c:v', 'libwebp', '-lossless', '0',
        '-q:v', String(quality),
        '-compression_level', '4',
        '-threads', '2',
        '-loop', '0', '-f', 'webp', outputPath
    );
    await run('ffmpeg', args, 120000);
    if (!fs.existsSync(outputPath)) throw new Error('FFmpeg did not create a WebP output.');
    return fs.statSync(outputPath).size;
}

async function createVideoIntermediate(inputPath, basePath, duration, sourceFps) {
    const fps = Math.min(15, Math.max(8, Math.round(sourceFps || 15)));
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-t', duration.toFixed(3), '-i', inputPath,
        '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', 'fps=' + fps +
            ',scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos' +
            ',format=bgra,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0',
        '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgra',
        basePath
    ], 120000);
    return fps;
}

async function createSample(inputPath, samplePath, duration, baseFps) {
    const sampleDuration = Math.min(1.5, duration);
    let select;
    if (duration <= sampleDuration + 0.05) {
        select = 'select=gte(t\\,0)';
    } else {
        const window = sampleDuration / 3;
        const middle = Math.max(0, (duration - window) / 2);
        const end = Math.max(0, duration - window);
        select = "select='between(t,0," + window.toFixed(3) + ")+" +
            'between(t,' + middle.toFixed(3) + ',' + (middle + window).toFixed(3) + ")+" +
            'between(t,' + end.toFixed(3) + ',' + duration.toFixed(3) + ")'";
    }
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inputPath,
        '-vf', select + ',setpts=N/(' + baseFps + '*TB)',
        '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgra',
        samplePath
    ], 60000);
    return sampleDuration;
}

async function encodeAnimatedWebp(inputPath, outputPath, visualType, duration, maxBytes, sourceFps = 15) {
    const imageInput = visualType === 'image';
    const targetBytes = Math.max(1, maxBytes - METADATA_RESERVE);
    let attempts = 0;
    let lastSize = 0;
    let lastError = null;

    if (imageInput) {
        for (const [fps, quality, dimension] of [[12, 58, 512], [10, 42, 448], [8, 28, 384]]) {
            attempts += 1;
            try {
                await encodeWebpFile(inputPath, outputPath, fps, quality, dimension, duration, true);
                addStickerExifFile(outputPath);
                lastSize = fs.statSync(outputPath).size;
                if (lastSize <= maxBytes) return { bytes: lastSize, fps, quality, dimension, attempts };
            } catch (error) {
                lastError = error;
                if (/not found/i.test(error.message)) throw error;
            }
        }
    } else {
        const basePath = path.join(path.dirname(outputPath), 'soniva-video-base.mkv');
        const samplePath = path.join(path.dirname(outputPath), 'soniva-video-sample.mkv');
        try {
            const baseFps = await createVideoIntermediate(inputPath, basePath, duration, sourceFps);

            // Very short clips usually fit without sampling; keep this path to one fast encode.
            let selectedIndex = 0;
            if (duration > 3) {
                await createSample(basePath, samplePath, duration, baseFps);
                const sampleDuration = Math.min(1.5, duration);
                const sampleIndices = [0, 3, 6];
                const measurements = [];
                for (const index of sampleIndices) {
                    const [fps, quality, dimension] = VIDEO_LADDER[index];
                    const sampleOutput = outputPath + '.sample-' + index + '.webp';
                    try {
                        attempts += 1;
                        const bytes = await encodeWebpFile(
                            samplePath, sampleOutput, fps, quality, dimension, sampleDuration
                        );
                        measurements.push({ index, predicted: bytes * duration / sampleDuration });
                    } finally {
                        fs.rmSync(sampleOutput, { force: true });
                    }
                }
                const fitting = measurements.filter(item => item.predicted <= targetBytes * 0.88);
                selectedIndex = fitting.length
                    ? Math.min(...fitting.map(item => item.index))
                    : 6;
            }

            let fullEncodes = 0;
            for (let index = selectedIndex;
                index < VIDEO_LADDER.length && fullEncodes < MAX_FULL_ENCODINGS;
                index++) {
                const [fps, quality, dimension] = VIDEO_LADDER[index];
                attempts += 1;
                fullEncodes += 1;
                try {
                    await encodeWebpFile(basePath, outputPath, fps, quality, dimension, duration);
                    addStickerExifFile(outputPath);
                    lastSize = fs.statSync(outputPath).size;
                    if (lastSize > 0 && lastSize <= maxBytes) {
                        return { bytes: lastSize, fps, quality, dimension, attempts };
                    }
                } catch (error) {
                    lastError = error;
                    if (/not found/i.test(error.message)) throw error;
                }
            }
        } finally {
            fs.rmSync(basePath, { force: true });
            fs.rmSync(samplePath, { force: true });
        }
    }

    if (lastError && !lastSize) throw new Error('Gagal membaca atau mengenkode media: ' + lastError.message);
    throw new Error(
        'Animasi masih melebihi batas ' + Math.ceil(maxBytes / 1024) +
        ' KB setelah estimasi sampel dan maksimal ' + MAX_FULL_ENCODINGS +
        ' encoding penuh. Coba potong durasi video atau gunakan video yang lebih sederhana.'
    );
}

async function encodeAudio(inputPath, outputPath, duration, audioBitrate) {
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inputPath, '-map', '0:a:0', '-vn',
        '-af', 'aresample=48000:first_pts=0,apad=whole_dur=' + duration.toFixed(3),
        '-t', duration.toFixed(3), '-ac', '1', '-ar', '48000',
        '-c:a', 'libopus', '-b:a', audioBitrate, '-vbr', 'on',
        '-application', 'audio', '-map_metadata', '-1',
        '-avoid_negative_ts', 'make_zero', '-f', 'ogg', outputPath
    ], 120000);
}

async function createSoundStickerAssets(options) {
    const { visualPath, audioPath, visualType, maxSeconds, maxBytes } = options;
    const audioBitrate = options.audioBitrate || '32k';
    if (!fs.existsSync(visualPath) || !fs.existsSync(audioPath)) throw new Error('A source media file is missing.');

    const audioInfo = await probeMedia(audioPath);
    if (!audioInfo.hasAudio) throw new Error('The selected audio does not contain a readable audio track.');

    let duration = Math.min(audioInfo.audioDuration || audioInfo.formatDuration, maxSeconds);
    let encodingType = visualType;
    let visualInfo = null;
    if (visualType === 'sticker') encodingType = options.stickerAnimated ? 'video' : 'image';
    if (encodingType === 'video') {
        visualInfo = await probeMedia(visualPath);
        if (!visualInfo.video) throw new Error('The selected video has no readable video track.');
        if (visualInfo.video.codec_name === 'webp') {
            throw new Error('Media terdeteksi sebagai WebP, bukan video biasa. FFmpeg server tidak dapat mendekode animasi WebP sumber ini.');
        }
        duration = Math.min(duration, visualInfo.videoDuration || duration);
    } else if (encodingType !== 'image') {
        throw new Error('This media type cannot be converted into a sound sticker.');
    }
    if (!Number.isFinite(duration) || duration < 0.5) throw new Error('The audio or video is too short to create a sound sticker.');

    const webpPath = path.join(options.workDir, 'soniva-sticker.webp');
    const oggPath = path.join(options.workDir, 'soniva-audio.ogg');
    // The audio and visual tracks are independent; run their encoders together.
    const [encoded] = await Promise.all([
        encodeAnimatedWebp(
            visualPath, webpPath, encodingType, duration, maxBytes, visualInfo?.fps || 12
        ),
        encodeAudio(audioPath, oggPath, duration, audioBitrate)
    ]);
    const finalAudioInfo = await probeMedia(oggPath);
    if (!finalAudioInfo.hasAudio || !fs.existsSync(oggPath) || fs.statSync(oggPath).size < 100) {
        throw new Error('FFmpeg did not produce a valid Opus audio file.');
    }
    return {
        webpPath, oggPath, duration,
        stickerBytes: encoded.bytes, fps: encoded.fps, quality: encoded.quality, dimension: encoded.dimension, compressionAttempts: encoded.attempts
    };
}

module.exports = { run, assertMediaTools, probeMedia, createSoundStickerAssets, fpsCandidates, buildStickerExif, addStickerExif, STICKER_PACK_NAME, STICKER_PACK_PUBLISHER };
