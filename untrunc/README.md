# untrunc (downloaded on first run)

This folder is intentionally empty in the repository. On Windows, `fix-vods.js`
downloads the latest release of [untrunc](https://github.com/anthwlock/untrunc)
into it the first time it runs, after asking you. Everything in here except this
file is ignored by git.

untrunc is a separate project licensed under the GNU GPL version 2 or later. Its
Windows release also bundles FFmpeg libraries built under GPL version 3, so the
release as a whole is GPLv3-or-later. It is not distributed by this repository.
Your machine fetches it directly from the upstream project.

- To use a different build, put `untrunc.exe` (and any DLLs it needs) in this folder.
- To remove it, delete everything here except this file.
- To share a copy of this repository, delete the downloaded files first, or you
  become a distributor of untrunc and must follow the GPL yourself.
