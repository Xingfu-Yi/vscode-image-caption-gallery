These short test-pattern videos were generated for this project with FFmpeg's
`testsrc2` and 440 Hz `sine` sources. They contain no third-party footage and are
covered by the project's MIT license. Test media are excluded from the VSIX.

- `video-sample.webm`: 320 × 180, 15 fps, 3 seconds, VP8 / Vorbis, native playback.
- `video-aac.mp4`: same generated sources, H.264 / AAC, audio compatibility input.
- `video-compatible.mp4`: AAC fixture converted to H.264 / MP3, browser QA output.
- `streaming-timeline.mp4`: 40 seconds, 320 × 180 at 10 fps, H.264 / AAC, a generated test pattern with a visible timestamp for distant seeking and cross-fragment playback.
- `video-legacy.avi`: 0.8 seconds from WebM, MPEG-4 Part 2 / PCM, legacy input.

Example native fixture generation:

```sh
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=15 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 \
  -c:v libvpx -b:v 180k -c:a libvorbis -q:a 3 -shortest video-sample.webm
```

Example streaming timeline generation (a local font path may be needed for `drawtext`):

```sh
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=10 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 40 \
  -vf "drawtext=text='%{pts\:hms}':x=5:y=5:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 20 -threads 2 \
  -c:a aac -movflags +faststart streaming-timeline.mp4
```
