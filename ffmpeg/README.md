# ffmpeg (downloaded on first run)

This folder is intentionally empty in the repository. On Windows, `fix-vods.js`
downloads an LGPL build of [ffmpeg](https://ffmpeg.org/) from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) into it the first
time it runs, after asking you, unless ffmpeg and ffprobe are already in your
PATH. Everything in here except this file is ignored by git.

ffmpeg is a separate project. The build fetched here is licensed under the GNU
LGPL version 3 or later. Its `LICENSE.txt` comes with the download. It is not
distributed by this repository. Your machine fetches it directly from the
upstream builds.

## Using your own ffmpeg instead

Either install ffmpeg and add it to PATH (PATH is checked first), or put the
files in this folder. Subfolders are fine. The script searches this folder
recursively for `ffmpeg.exe` and `ffprobe.exe`.

Which files you need depends on the kind of build:

- **Static build** (gyan.dev "essentials" or "full", or a BtbN zip without
  `shared` in its name): only `ffmpeg.exe` and `ffprobe.exe`. No DLLs.
- **Shared build** (a zip with `shared` in its name, which is what the script
  downloads): `ffmpeg.exe`, `ffprobe.exe`, and the seven library DLLs from the
  build's `bin` folder, side by side with the executables. Both executables
  import all seven, so none can be left out:

  | Library | File in the current build |
  |---------|---------------------------|
  | avutil | `avutil-61.dll` |
  | avcodec | `avcodec-63.dll` |
  | avformat | `avformat-63.dll` |
  | avdevice | `avdevice-63.dll` |
  | avfilter | `avfilter-12.dll` |
  | swresample | `swresample-7.dll` |
  | swscale | `swscale-10.dll` |

  The numbers are library versions and change between FFmpeg releases (FFmpeg
  7.1 ships `avcodec-61.dll`, for example), so copy whichever `av*.dll` and
  `sw*.dll` files your build has. If your build's `bin` folder has any other
  DLL (GPL builds add `postproc-*.dll`), copy that too. `ffplay.exe` and the
  `include`, `lib`, and `doc` folders are not needed.

The list above was verified against the build the script downloads (FFmpeg git
master, September 2026): with exactly these nine files in an otherwise empty
folder, both executables start, and probing and `-c copy` remuxing work.
Removing any one of the DLLs makes them fail to start.

To check your copy, open a command prompt in the folder and run
`ffprobe -version`.
