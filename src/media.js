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

        child.stdout.on('data', (chunk) => {
            if (stdout.length < 2 * 1024 * 1024) stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < 2 * 1024 * 1024) stderr += chunk.toString();
        });

        child.once('error', (error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (error.code === 'ENOENT') {
                reject(new Error(binary + ' was not found. Install FFmpeg and make sure it is available in PATH.'));
            } else {
                reject(error);
            }
        });

        child.once('close', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const detail = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
                reject(new Error(binary + ' exited with code ' + code + (detail ? ': ' + detail : '.')));
            }
        });
    });
}

async function assertMediaTools() {
    await run('ffmpeg', ['-hide_banner', '-version'], 15000);
    await run('ffprobe', ['-hide_banner', '-version'], 15000);
    const encoders = await run('ffmpeg', ['-hide_banner', '-encoders'], 20000);
    if (!/\blibwebp\b/.test(encoders.stdout)) {
        throw new Error('FFmpeg is missing the libwebp encoder. Install an FFmpeg build with WebP support.');
    }
    if (!/\blibopus\b/.test(encoders.stdout)) {
        throw new Error('FFmpeg is missing the libopus encoder. Install an FFmpeg build with Opus support.');
    }
    return true;
}

async function probeMedia(filePath) {
    const result = await run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type,duration,width,height,channels,sample_rate',
        '-of', 'json',
        filePath
    ], 30000);

    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        throw new Error('FFprobe returned invalid media information.');
    }

    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const audio = streams.find((stream) => stream.codec_type === 'audio') || null;
    const video = streams.find((stream) => stream.codec_type === 'video') || null;
    const formatDuration = Number.parseFloat(parsed.format?.duration) || 0;
    const audioDuration = Number.parseFloat(audio?.duration) || formatDuration;
    const videoDuration = Number.parseFloat(video?.duration) || formatDuration;

    return {
        streams,
        audio,
        video,
        hasAudio: Boolean(audio && Number(audio.channels || 1) > 0),
        formatDuration,
        audioDuration,
        videoDuration
    };
}

async function encodeAnimatedWebp(inputPath, outputPath, visualType, duration, maxBytes) {
    const variants = [
        { fps: 12, quality: 50 },
        { fps: 10, quality: 45 },
        { fps: 8, quality: 40 },
        { fps: 6, quality: 35 },
        { fps: 5, quality: 30 }
    ];

    let lastSize = 0;
    for (const variant of variants) {
        try {
            fs.rmSync(outputPath, { force: true });
            const args = ['-hide_banner', '-loglevel', 'error', '-y'];

            if (visualType === 'image') {
                args.push('-loop', '1', '-framerate', String(variant.fps), '-i', inputPath);
            } else {
                args.push('-i', inputPath);
            }

            const filter =
                'fps=' + variant.fps +
                ',scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos' +
                ',format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';

            args.push(
                '-t', duration.toFixed(3),
                '-an',
                '-vf', filter,
                '-c:v', 'libwebp',
                '-lossless', '0',
                '-q:v', String(variant.quality),
                '-compression_level', '4',
                '-threads', '2',
                '-loop', '0',
                '-f', 'webp',
                outputPath
            );

            await run('ffmpeg', args, 120000);
            lastSize = fs.statSync(outputPath).size;
            if (lastSize > 0 && lastSize <= maxBytes) {
                return { bytes: lastSize, fps: variant.fps, quality: variant.quality };
            }
        } catch (error) {
            if (error.message.includes('not found')) throw error;
            throw new Error('Unable to encode the animation: ' + error.message);
        }
    }

    throw new Error(
        'The animated sticker is still too large (' + Math.ceil(lastSize / 1024) +
        ' KB). Try a shorter video or a simpler image.'
    );
}

async function createSoundStickerAssets(options) {
    const visualPath = options.visualPath;
    const audioPath = options.audioPath;
    const visualType = options.visualType;
    const maxSeconds = options.maxSeconds;
    const maxBytes = options.maxBytes;
    const audioBitrate = options.audioBitrate || '32k';

    if (!fs.existsSync(visualPath) || !fs.existsSync(audioPath)) {
        throw new Error('A source media file is missing.');
    }

    const audioInfo = await probeMedia(audioPath);
    if (!audioInfo.hasAudio) {
        throw new Error('The selected audio does not contain a readable audio track.');
    }

    let duration = Math.min(audioInfo.audioDuration || audioInfo.formatDuration, maxSeconds);
    let encodingType = visualType;

    if (visualType === 'sticker') {
        encodingType = options.stickerAnimated ? 'video' : 'image';
    }

    if (encodingType === 'video') {
        const visualInfo = await probeMedia(visualPath);
        if (!visualInfo.video) throw new Error('The selected video has no readable video track.');
        duration = Math.min(duration, visualInfo.videoDuration || duration);
    } else if (encodingType !== 'image') {
        throw new Error('This media type cannot be converted into a sound sticker.');
    }

    if (!Number.isFinite(duration) || duration < 0.5) {
        throw new Error('The audio or video is too short to create a sound sticker.');
    }

    const webpPath = path.join(options.workDir, 'soniva-sticker.webp');
    const oggPath = path.join(options.workDir, 'soniva-audio.ogg');

    const encoded = await encodeAnimatedWebp(
        visualPath, webpPath, encodingType, duration, maxBytes
    );

    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', audioPath,
        '-map', '0:a:0',
        '-vn',
        '-t', duration.toFixed(3),
        '-ac', '1',
        '-ar', '48000',
        '-c:a', 'libopus',
        '-b:a', audioBitrate,
        '-vbr', 'on',
        '-application', 'audio',
        '-f', 'ogg',
        oggPath
    ], 120000);

    const finalAudioInfo = await probeMedia(oggPath);
    if (!finalAudioInfo.hasAudio || !fs.existsSync(oggPath) || fs.statSync(oggPath).size < 100) {
        throw new Error('FFmpeg did not produce a valid Opus audio file.');
    }

    return {
        webpPath,
        oggPath,
        duration,
        stickerBytes: encoded.bytes,
        fps: encoded.fps,
        quality: encoded.quality
    };
}

module.exports = { run, assertMediaTools, probeMedia, createSoundStickerAssets };
