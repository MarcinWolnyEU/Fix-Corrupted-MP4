# Fix Corrupted MP4

Your live-stream recording will not play in VLC, the file is hundreds of megabytes, and ffprobe says `moov atom not found`. This tool fixes that. It repairs MP4 recordings that were cut off before the recorder finished writing the file: a browser crash, a network drop, or a closed tab while [Video DownloadHelper](https://downloadhelper.net/) or another recorder built on OvenMediaEngine/Lavf was still recording. Those recorders write the `moov` atom (the file's index) only at the end, so the audio and video data is all there in the `mdat` atom, but no player can find it.

It is a drag-and-drop front-end for [untrunc](https://github.com/anthwlock/untrunc) and [ffmpeg](https://ffmpeg.org/) on Windows (an untrunc GUI, if that is what you were searching for), with a fallback that rebuilds the `moov` atom itself when untrunc cannot.

## Symptoms

Tested on a 334 MB recording from Video DownloadHelper. The exact messages, so you can compare them with what you see:

- **VLC** (3.0.21) opens the file but plays nothing. With verbose logging it reports `MP4 plugin discarded (not a valid initialization chunk)` and `moov atom not found`, then tries to read the file as an MPEG program stream and gets nowhere.
- **ffprobe** prints `moov atom not found` followed by `Invalid data found when processing input`.
- **A plain ffmpeg remux does not work.** `ffmpeg -i recording.mp4 -c copy fixed.mp4`, the usual first suggestion, fails with `Error opening input: Invalid data found when processing input`. ffmpeg needs the `moov` atom to read the file at all. `-movflags +faststart` does not apply either: it moves an existing `moov` to the front, it does not create one.
- **The file size looks normal.** The data is there, only the index is missing.

## Quick start

**Windows, no command line needed:** install [Node.js](https://nodejs.org/) (the latest LTS is the safe pick, version 16 is the minimum), download this repository as a ZIP and unpack it, then drag the broken recordings, or the folder containing them, onto `fix-vods.cmd`. One Windows quirk: if a path contains an ampersand or a caret and no spaces, Windows mangles it before the launcher sees it, so type or paste such a path instead of dragging it. On the first run the script offers to download ffmpeg and untrunc (about 80 MB together) into the `ffmpeg/` and `untrunc/` folders. It needs them to process the files. The ffmpeg download is skipped if ffmpeg is already installed on the system. The script asks about everything else as it runs.

**Command line:**

```bash
# Fix every broken MP4 in a directory:
node fix-vods.js -i "path\to\recordings"

# Fix specific files (a working recording next to them is picked up as the reference):
node fix-vods.js "path\to\recordings\stream1.mp4" "path\to\recordings\stream2.mp4"

# Use a specific known-good recording from the same source as the reference:
node fix-vods.js -i "path\to\recordings" -r "path\to\working-recording.mp4"
```

Requirements: [Node.js](https://nodejs.org/) 16+. The script also uses [ffmpeg](https://ffmpeg.org/) and, for full audio and video recovery, [untrunc](https://github.com/anthwlock/untrunc). On Windows the script offers to download both on the first run if they are not already installed. On other platforms, install ffmpeg with your package manager and install or build untrunc yourself. Without untrunc you still get video-only recovery.

## How it works

The script tries two strategies in order.

### 1. untrunc (audio and video)

untrunc reconstructs the `moov` atom using a working MP4 as a template, which preserves both tracks.

The reference has to come from the same source and be in the same format as the broken file: the same video codec, the same audio codec, and the same output format. It does not have to be the same recording, and its length does not matter, so a short clip from the same setup works as well as a long one. A file from a different recorder, or one re-encoded to different codecs, will not work.

Pass the reference with `-r`, or simply put the file in the same folder as the broken recordings: any name ending in `.mp4` is picked up automatically, except names ending in `_fixed.mp4`, which are this tool's own output. If it finds none, it explains these requirements and asks for a path, so audio recovery is not skipped silently. The result is re-muxed through ffmpeg to clean up timestamps and produce a standard-compliant file.

The script runs untrunc with `-n` (non-interactive) and `-sv` (stretch video to match audio duration, which corrects guessed frame durations).

### 2. Rebuilding the moov (video only)

When untrunc is unavailable or fails, the script parses the `mdat` data directly, reconstructs a `moov` atom from scratch, and re-muxes through ffmpeg. Only Node.js and ffmpeg are needed.

The framerate is read from the H.264 SPS timing info when the stream carries it. If it does not, the script falls back to the reference file's framerate, and as a last resort assumes 30 fps and warns about it. Keyframes are marked at the actual IDR frames found during scanning, so seeking works correctly.

Audio is lost in this mode. The raw AAC frames between video access units have no framing markers, and the only record of their sizes was in the `moov` that never got written.

This fallback is tuned to OvenMediaEngine-style recordings: AVCC H.264 with access-unit delimiters and `mdat` data starting at file offset 48. Files from other recorders may only work through the untrunc path.

## Options

| Flag | Description |
|------|-------------|
| `-i, --input <path>` | Directory (every MP4 inside is checked) or a single MP4 file. May be repeated. Paths given without `-i` work the same way. Default: current directory |
| `-o, --output <dir>` | Output directory for fixed files (default: next to each input file) |
| `-r, --reference <file>` | An intact MP4 from the same source, in the same format (same video codec, same audio codec, same output format). A different clip of any length is fine. Without this flag, the first valid MP4 among the inputs is used, or one found next to the broken files. If there is none, the script asks for a path |
| `--copy` | Save fixed files as new copies (`*_fixed.mp4`) |
| `--inplace` | Replace originals after a successful repair |
| `--no-download` | Never download ffmpeg or untrunc. Use only what is already installed (PATH or the local folders) |
| `-h, --help` | Show help |

When neither `--copy` nor `--inplace` is given, the script asks interactively and recommends copy mode.

## Safeguards

The script never touches originals in copy mode. Fixed files are written alongside them as `*_fixed.mp4`. In-place mode writes the fixed file separately first and only replaces the original after the repair succeeds, and choosing it interactively requires a typed confirmation. It is still destructive: the broken original is gone afterwards and cannot be re-processed later with a better reference file.

Before processing, each file is checked: files with a working `moov` (verified with ffprobe) are skipped, as are `*_fixed.mp4` outputs from earlier runs and files that are not MP4s at all. Broken recordings often pre-allocate `mdat` space and fill only part of it, so the script finds where real data ends and ignores the zero-padding. untrunc output is validated too. If it comes back without a video track, the script falls through to the moov rebuild.

## Technical details

### Broken file structure

Broken files from OvenMediaEngine-based recorders look like this:

```
[ftyp: 32 bytes] [free: 8 bytes] [mdat header: 8 bytes] [real data] [zero padding] [moov: MISSING]
```

The `mdat` size field claims more than the file holds, because the space was pre-allocated but the recording died before it was filled. In the tested files, real data ended around 44% of the file size. Some files also have a large zero-padded prefix (16 to 28 MB) before the data starts.

### mdat data format

The `mdat` interleaves video and audio samples.

Video samples are AVCC-formatted H.264 access units: a 4-byte big-endian length prefix per NALU rather than Annex B start codes. Each access unit starts with an AUD (type 9), followed by SPS/PPS/SEI on keyframes, then the slice.

Audio samples are raw AAC-LC frames with no ADTS headers, no length prefixes, and no sync markers (in the tested files: 48kHz stereo, roughly 230 to 270 bytes per frame). Frame boundaries are unrecoverable from the bitstream alone. The `moov`'s stsz table was the only record of them. This is why audio recovery requires untrunc and a reference file.

### Key moov box offsets (ISO 14496-12, version 0 boxes)

- mvhd: matrix at buffer offset 44, next_track_ID at 104
- tkhd: matrix at buffer offset 48, width at 84, height at 88 (16.16 fixed-point)
- edts/elst between tkhd and mdia, required for VLC/Avidemux compatibility

### untrunc integration notes

- untrunc appends to the full input path, so `foo.mp4` becomes `foo.mp4_fixed-sv.mp4`, not `foo_fixed-sv.mp4`
- `-sv` stretches video duration to match audio, fixing wrongly guessed frame durations
- untrunc writes AAC codec warnings to stderr even on success, so stderr is not treated as a failure signal
- untrunc can fail on files with large zero-padded prefixes ("unable to find correct codec" at the zero boundary). Those fall through to the moov rebuild
- DTS monotonicity warnings during validation are harmless timestamp artifacts of guessed frame durations

## License

Everything in this repository (`fix-vods.js`, `fix-vods.cmd`, and the documentation) is dedicated to the public domain under [CC0 1.0 Universal](LICENSE). You may copy, modify, distribute, and use it for any purpose, commercial or not, without asking permission or giving attribution.

I built this for my own use and I usually have neither the time nor the resources to support it. I hope it helps you, but I cannot promise it will fix your particular files, but it did fix mine. Please avoid replacing files in place: once the script has overwritten an original, there is no way to get it back.

The repository does not contain or distribute any third-party software. The `untrunc/` and `ffmpeg/` folders are placeholders whose contents are ignored by git. The script downloads the tools into them on your machine, at your request, straight from their upstream projects:

- [untrunc](https://github.com/anthwlock/untrunc) is licensed under the [GNU GPL version 2](https://github.com/anthwlock/untrunc/blob/master/COPYING) or later. Its Windows release also bundles FFmpeg libraries built under GPL version 3, so the release as a whole is GPLv3-or-later.
- [ffmpeg](https://ffmpeg.org/) is fetched from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds). The script picks the LGPL variant, licensed under the [GNU LGPL version 3](https://ffmpeg.org/legal.html) or later. Its license text ships inside the download.

The script runs both tools as separate command line processes and does not link against them, so their licenses do not extend to this project. If you pass on a copy of this repository together with the downloaded tools, you become a distributor of those tools and must follow their licenses yourself. The simplest way to avoid that is to delete the contents of the two folders before sharing.

This project is not affiliated with Video DownloadHelper in any way.