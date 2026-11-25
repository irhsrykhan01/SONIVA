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

function fpsCandidates(sourceFps, duration) {
    const cap = Math.min(20, Math.max(8, Math.round(sourceFps || 15)));
    const ladder = [cap, 18, 15, 12, 10, 8]
        .filter((fps, index, all) => fps <= cap && all.indexOf(fps) === index && fps * duration <= 200);
    return ladder.length ? ladder : [8];
}

async function encodeAnimatedWebp(inputPath, outputPath, visualType, duration, maxBytes, sourceFps = 15) {
    const fpsList = visualType === 'image' ? [12] : fpsCandidates(sourceFps, duration);
    // Reduce quantization/quality before reducing frame rate. Keep a practical
    // minimum of 8 fps so a sticker never silently degrades into a near-still image.
    const qualities = [70, 60, 50, 42, 35, 30, 25];
    let lastSize = 0;
    let lastError = null;

    for (const fps of fpsList) {
        for (const quality of qualities) {
            try {
                fs.rmSync(outputPath, { force: true });
                const args = ['-hide_banner', '-loglevel', 'error', '-y'];
                if (visualType === 'image') args.push('-loop', '1', '-framerate', String(fps), '-i', inputPath);
                else args.push('-i', inputPath);

                const filter = 'fps=' + fps +
                    ',scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos' +
                    ',format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';

                args.push(
                    '-t', duration.toFixed(3), '-an', '-vf', filter,
                    '-fps_mode', 'cfr',
                    '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(quality),
                    '-compression_level', '6', '-threads', '2',
                    '-loop', '0', '-f', 'webp', outputPath
                );
                await run('ffmpeg', args, 180000);
                lastSize = fs.statSync(outputPath).size;
                if (lastSize > 0 && lastSize <= maxBytes) {
                    return { bytes: lastSize, fps, quality };
                }
            } catch (error) {
                lastError = error;
                if (error.message.includes('not found')) throw error;
                // A WebP decoder error is an input/FFmpeg capability problem,
                // not a file-size problem. Retrying lower quality cannot fix it.
                if (/webp.*(decode|invalid)|Cannot determine format of input|Invalid data found/i.test(error.message)) {
                    throw new Error('FFmpeg tidak dapat membaca stream WebP sumber. Periksa format media yang terunduh dan dukungan decoder WebP pada FFmpeg: ' + error.message);
                }
            }
        }
    }

    if (lastError && !lastSize) throw new Error('Gagal membaca atau mengenkode media: ' + lastError.message);
    throw new Error(
        'Animasi masih melebihi batas ' + Math.ceil(maxBytes / 1024) +
        ' KB setelah kompresi kualitas dan FPS (minimum 8 FPS). Coba video yang lebih singkat.'
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
    const encoded = await encodeAnimatedWebp(
        visualPath, webpPath, encodingType, duration, maxBytes, visualInfo?.fps || 15
    );
    await encodeAudio(audioPath, oggPath, duration, audioBitrate);

    const finalAudioInfo = await probeMedia(oggPath);
    if (!finalAudioInfo.hasAudio || !fs.existsSync(oggPath) || fs.statSync(oggPath).size < 100) {
        throw new Error('FFmpeg did not produce a valid Opus audio file.');
    }
    return {
        webpPath, oggPath, duration,
        stickerBytes: encoded.bytes, fps: encoded.fps, quality: encoded.quality
    };
}

module.exports = { run, assertMediaTools, probeMedia, createSoundStickerAssets, fpsCandidates };
