# MP4 moov atom recovery: technical notes

## Context

Fixing broken MP4 files from interrupted live-stream recordings (OvenMediaEngine/Lavf encoder). The files have valid `mdat` data but no `moov` atom.

## Key findings

### File structure

Broken files:
```
[ftyp: 32B][free: 8B][mdat header: 8B][mdat data: ~700MB real][~900MB zeros][moov: MISSING]
```

Working files (same encoder):
```
[ftyp: 32B][free: 8B][mdat header: 8B][mdat data...][moov: 131KB+]
```

- The mdat box size field in broken files is wrong: it claims more bytes than the file holds. The recording was interrupted before the size field could be finalized.
- Real data occupies only the first ~44% of the file. The remaining ~56% is zero-padded (pre-allocated but never written).
- mdat data starts at file offset 48 (ftyp=32 + free=8 + mdat_header=8).
- The `moov` atom was never written: the classic truncated live stream.

### Data format inside mdat

The mdat contains interleaved video and audio samples:

Video samples = AVCC-formatted H.264 access units:
- 4-byte big-endian length prefix per NALU (not Annex B start codes)
- Each access unit starts with AUD (type 9), then SPS/PPS/SEI for keyframes, then IDR or non-IDR slice
- Confirmed: `nal_length_size=4` (from working file's avcC box)

Audio samples = raw AAC-LC frames (no ADTS headers, no length prefix):
- Stored between video access units
- AAC-LC at 48kHz stereo, ~230-270 bytes per frame, AudioSpecificConfig = `0x11 0x90`
- 1024 PCM samples per AAC frame
- Frame boundaries are not marked: no sync words, no length fields
- Reference file has 79950 audio frames, 51225 video frames (~1.56 audio frames per video frame)

Interleave pattern: `[video AU][audio AAC frame(s)][video AU][audio AAC frame(s)]...`
- Audio stsc alternates: 2 frames per chunk, then 1, then 2, etc.
- Each "chunk" = one gap between video AUs
- Gap sizes: ~450-530 bytes for 2-frame gaps, ~250 bytes for 1-frame gaps

Gotcha: after a video AU ends, the next bytes are raw audio data that do not parse as valid AVCC (the 4-byte "length" values are garbage). They are interleaved audio, not corruption.

### SPS parsing

The SPS payload starts at `buf[avcc_offset + 5]` (4-byte length + 1-byte NAL header). The first byte is `profile_idc`. Exp-Golomb parsing must start at bit position 24 (after the 3 header bytes), not bit 3.

### AAC frame detection

Raw AAC-LC frames in the mdat consistently start with bytes `0x21 0x19` (verified across reference file). This is a valid AAC-LC single_channel_element start. The pattern `0x21 0x19` is very unlikely (~1/65536) to appear as data within a frame, so it's a reliable frame boundary marker.

Gap data pattern:
```
gap[0]=508B: 21 19 94 ad ad cf 62 ...    ← AAC frame 1
gap[1]=530B: 21 19 94 a5 ae 54 ...       ← AAC frame 1
gap[2]=1274B: 21 19 94 b5 ae 5e ...      ← Multiple frames!
gap[14]=4384B: 00 00 0f 19 0c ...        ← Different pattern (unusual gap)
```

### moov box structure: correct byte offsets

Identity matrix `{0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000}`:
- mvhd matrix: buffer offset 44 (an earlier version wrote it at 40, off by 4)
- tkhd matrix: buffer offset 48 (mvhd and tkhd differ. An earlier version used 44 for both, which lands in the tkhd volume field and shifts width/height into the matrix region. ffmpeg tolerated it because it takes dimensions from the SPS, but it was wrong per ISO 14496-12)

### moov box structure bugs found

Bug 1: mvhd matrix at wrong byte offsets
- Code wrote matrix at buffer offset 40, correct is 44 (off by 4, not 2)
- Identity matrix at buffer offsets 44-79
- next_track_ID at buffer offset 104

Bug 2: tkhd volume = 0x0100 for video track
- Should be 0x0000 for video tracks (0x0100 = 1.0 only for audio tracks)

Bug 3: missing edts/elst box
- Working reference has edts→elst between tkhd and mdia in each trak
- Our moov was missing this entirely
- VLC/Avidemux may require this for proper playback

Bug 4: audio track moov with wrong sample boundaries
- Treating each gap (2-3 AAC frames concatenated) as one audio sample
- AAC decoder expects one frame per sample → 44905 out of 44906 decode failures
- Need to split gaps into individual AAC frames before building audio stsz

### What actually works

ffmpeg `-c copy` re-mux step:
- Our moov-building produces a file that ffmpeg can read (45138 frames, 0 video decode errors)
- `ffmpeg -i our_file.mp4 -c copy -map 0:v output.mp4` produces a clean, standard-compliant MP4
- The ffmpeg output has proper edts/elst, matrix, chunking, etc.
- Video-only ffmpeg output: 0 decode errors, seekable to any position
- This is the critical step that makes the file playable in VLC/Avidemux

Audio detection:
- Each gap starts with `0x21 0x19` (raw AAC-LC frame marker)
- Can scan for this pattern within each gap to find individual AAC frame boundaries
- Average frame size ~246 bytes, median ~246 bytes

### Dead ends explored

1. **`ffmpeg -i broken.mp4`** — fails immediately: "moov atom not found"
2. **`ffmpeg -f h264 -i broken.mp4`** — fails: data is AVCC not Annex B, no start codes found
3. **Extracting video as Annex B and re-muxing** — works for video but produces H.264 decode errors because AUD pattern `00 00 00 02 09` matches in raw AAC audio data
4. **Searching for Annex B start codes** (`00 00 01`) in the mdat — none found, data is AVCC
5. **Searching for ADTS sync** (`0xFFF`) — no ADTS headers in raw AAC data
6. **Parsing entire mdat as continuous AVCC** — breaks at video/audio boundary where audio bytes look like invalid NALUs
7. **Building moov with wrong matrix offsets** — produced files that ffmpeg could read but VLC/Avidemux rejected
8. **Treating each audio gap as single AAC sample** — 44905/44906 decode failures because gaps contain multiple concatenated frames
9. **`ffmpeg -f aac` with raw AAC bytes** — failed: "Error decoding AAC frame header" (no ADTS sync)
10. **VLC `--intf dummy` testing on Windows** — VLC hangs without exiting in dummy mode. Not reliable for headless validation. Use ffmpeg full decode test instead.
11. **VLC headless testing with `--vout=none`** — produces confusing "video output creation failed" errors for all files (even known-good ones). Not a file format issue.

### Audio recovery is not feasible without untrunc

The core problem: raw AAC-LC frames in the mdat have no sync markers, no length fields, and no distinguishable byte patterns. Frame boundaries are indistinguishable from random data within frames.

Tried and failed:
- Pattern detection (`0x21 0x19`): only matches first 2 frames per chunk, not the rest (random bytes inside frames)
- Equal-size splitting at 350-byte threshold: 100% correct frame count but ~6 bytes boundary error on average → AAC decoder fails catastrophically (12,659 errors)
- The first byte distribution of AAC frames is essentially uniform (0x00-0xFF): no magic values
- ffmpeg's raw AAC demuxer (`-f aac`): can't find valid frame boundaries either. It detects garbage codec params (7350Hz/3ch)
- Reference frame size ratios as templates: content-dependent, avg 31-byte error per frame boundary (too much for AAC)
- ADTS-wrapping whole gaps as single frames: AAC decoder rejects multi-frame "samples"

Why this is hard: an AAC-LC raw bitstream without ADTS headers is just a sequence of coded spectral data. There are no sync patterns, no magic bytes, no frame delimiters. The only way to know where one frame ends and the next begins is the moov's stsz table, which is what was lost.

The only viable audio recovery approach is `untrunc` (or equivalent), which uses a working reference file's moov to reconstruct exact per-sample frame sizes. It works by:
1. Learning the frame size pattern from the reference
2. Walking through the broken file using those sizes as a template
3. Using codec-aware validation to handle size mismatches

If untrunc is unavailable, video-only recovery is still valuable: the video plays perfectly in VLC/Avidemux.

### untrunc integration

untrunc (`./untrunc/untrunc.exe`, auto-downloaded from GitHub by fix-vods.js) successfully recovers video+audio from truncated MP4 files using a working reference file's moov as template.

Usage: `untrunc.exe -n -sv reference.mp4 broken.mp4`
- `-n`: non-interactive mode
- `-sv`: stretches video to match audio duration (important when frame durations are guessed wrong)

untrunc output naming: appends directly to the input path: `input.mp4_fixed-sv.mp4` (not `input_fixed-sv.mp4`).

Known issues:
- untrunc reports AAC codec warnings to stderr even on success, so don't treat stderr content as failure
- untrunc produces `_fixed-sv.mp4` (stretched) and/or `_fixed.mp4` (non-stretched). Check for both
- Video/Audio duration mismatch: untrunc warns "guessed frame durations will be wrong". Use `-sv` to fix
- DTS monotonicity: 313-1041 warnings per file. Harmless timestamp issues, re-mux through ffmpeg to clean

untrunc failures: 2 of the 7 test files failed because the data starts after a large zero-padded region (16MB/28MB). untrunc hits "unable to find correct codec -> premature end" because it tries to parse zeros as codec data. These files still recover via moov-build fallback.

### Zero-padded prefix files

Some broken files have a large zero-padded region at the start of mdat before any actual data. Among the test files:
- a 107MB file with the first non-zero byte at 16.3MB (15%)
- a 1509MB file with the first non-zero byte at 28MB (1.8%)

The data after the zero prefix is valid H.264 AVCC with proper AUD/SPS/PPS structure. The fix is to scan forward from the first non-zero byte for the first valid AU with SPS/PPS.

### Recommended approach

1. Build moov with video track (corrected matrix, edts/elst) → write to temp file
2. ffmpeg `-c copy -map 0:v` re-mux → clean video-only MP4 (fixes all moov structure issues)
3. Validate with `ffmpeg -v error -i file.mp4 -f null -` (full decode, count errors)
4. For audio: use `untrunc` with a working reference file from the same encoder
5. If untrunc unavailable: deliver video-only as the recovery result

### Implementation notes

- Process one file at a time. Don't batch all files in one run (memory/time issues)
- Always validate output with `ffmpeg -v error -f null -` before declaring success
- Test with both VLC and Avidemux. Don't assume ffmpeg acceptance means player acceptance
- The mdat size field must be corrected: `writeEnd - 40` (the mdat box includes its 8-byte header at offset 40)

### Reference file structure (example)

```
Video: H.264 Main, 1280x720, 30fps, timescale 90000
Audio: AAC-LC, 48kHz stereo, esds AudioSpecificConfig 0x1190
  stsc: alternating 2/1 samples per chunk (45028 entries)
  stsz: 79950 individual AAC frame sizes (220-310 bytes each, median 246)
  stco: 51225 chunk offsets (one per video frame period)
```

### Key byte offsets in moov

mvhd (108 bytes for version 0):
- 0-7: box header (size + "mvhd")
- 8-11: version(0) + flags(0)
- 12-19: creation_time(0) + modification_time(0)
- 20-23: timescale (4 bytes)
- 24-27: duration (4 bytes)
- 28-31: rate = 0x00010000 (1.0 in 16.16 fixed-point)
- 32-33: volume = 0x0100 (1.0 in 8.8 fixed-point)
- 34-35: reserved (0)
- 36-43: reserved (0, 0)
- 44-79: matrix (36 bytes, 9 × 4-byte elements)
- 80-103: pre_defined (24 bytes, 0)
- 104-107: next_track_ID

tkhd (92 bytes for version 0):
- 0-7: box header
- 8-11: version(0) + flags(3 = enabled + in_movie)
- 12-19: creation/modification time
- 20-23: track_ID
- 24-27: reserved
- 28-31: duration
- 32-39: reserved (8 bytes)
- 40-41: layer
- 42-43: alternate_group
- 44-45: volume (0 for video tracks)
- 46-47: reserved
- 48-83: matrix (36 bytes)
- 84-87: width (16.16 fixed-point)
- 88-91: height (16.16 fixed-point)

edts/elst (36 bytes total = 8 edts header + 28 elst):
- elst content: version(0) + flags(0) + entry_count(1) + segment_duration(4) + media_time(4) + media_rate(4)
- segment_duration in mvhd timescale
- media_time = 0 for normal start
- media_rate = 0x00010000 (1.0)

### VLC stale plugins cache

On Windows, VLC may show "stale plugins cache" errors for every DLL and then hang. Fix:
1. Delete `C:\Program Files\VideoLAN\VLC\plugins\plugins.dat`
2. Run `vlc --reset-plugins-cache` with admin privileges
3. VLC will regenerate the cache file on next launch

## Recordings over 4 GB (64-bit mdat), verified 2026-10-04

Target: a 6.78 GB, 4.9 hour recording whose tool output was "Not an MP4, skipping". Five things were wrong, and a sixth turned up while testing a second broken file.

- **64-bit mdat header:** the layout is `[ftyp 32][mdat: size=1, "mdat", 64-bit size][data from offset 48]`, with no `free` box. `readMp4Boxes` treated size 1 as invalid (< 8), saw no mdat, and the file was classified as not an MP4. The data offset and the mdat size patch in the intermediate file were also hard-coded for the 8-byte header. Both now come from the box that was found.
- **stco overflow:** offsets past 4 GB need `co64`. The rebuilt moov now switches to it when the last offset exceeds 0xFFFFFFFF.
- **Relative `-r` path:** untrunc is spawned with `cwd` = the broken file's folder, so `-r ../ref.mp4` failed with "Could not open file". The script now resolves it to an absolute path.
- **Slow parseAuAt:** it read 200 KB per access unit to look at a few NAL headers, which held the scan to about 340 MB per minute, and it would reject any keyframe over 200 KB. It now reads only the 5-byte header of each NAL.
- **MIN_AU_SIZE of 500:** it dropped valid frames. Near-static scenes have frames of 53 to 100 bytes. Ground truth on intact files (ffprobe packet count versus scan): 500 gave 51,746 of 51,792 and 402,098 of 407,575; 20 gave both exactly. On the target it recovered 4,432 frames (526,422 versus untrunc's 526,426).
- **Frame timing comes from the reference:** untrunc copies it, so an unrelated reference (the alphabetically first MP4 in the folder, which is what the old auto-pick chose) gave 12,812 s of video against 10,304 s of audio and the tool still said "fixed". References are now chosen per file by SPS resolution, profile and frame rate, and the output length is checked against frame count divided by the recording's own SPS frame rate. A video that is consistent with that but shorter than the audio is a property of the recording (77 s in one file; the raw data has 307,194 frames, untrunc wrote 307,198).

### Decode check

`ffmpeg -v error -f null -` prints one `non monotonically increasing dts` line per bad timestamp, and it prints the same ones for an intact recording (compared at two positions), so they are noise. The old code counted every stderr line as a harmless DTS warning, which would have hidden real decode errors. They are now counted separately. Both recordings tested end with 3 decode errors from the final cut-off access unit (size 77 and 18 bytes), which is expected.

spawnSync defaults also bit here: `maxBuffer` is 1 MB (one line per timestamp problem can exceed it, which kills ffmpeg and silently truncates the count), and the old 10 minute timeouts are too short for a multi-GB file. Both are raised.

### Practical numbers

- Free space: copy mode needs about twice the recording size (6.80 GB untrunc temp plus 6.80 GB output for a 6.78 GB input).
- Time on this machine: the video-only rebuild took 3m50s for the 6.78 GB file; the untrunc path took between 4 and 11 minutes end to end, depending on disk load (the disk was nearly full for the slow run).
- The video-only fallback worked on the 64-bit file once the offsets and header were handled (the scanner counted 521,990 frames before the frame-size fix and 526,422 after).

### Editing gotcha (Windows)

Python's text-mode `open(path, 'w')` writes CRLF on Windows. The repo stores LF, so a scripted edit silently converted all of `fix-vods.js` to CRLF, and one stray NUL byte (from an escaped `\0` in a patch string) made git treat the file as binary. Use `open(path, 'w', newline='')` for scripted edits, and check `git ls-files --eol` afterwards.
