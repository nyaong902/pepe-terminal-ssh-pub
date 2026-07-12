# EVS GStreamer plugin — build notes (macOS/Linux port)

This directory contains only the adapter code we wrote ourselves
(`ipgevs.c` / `ipgevs.h`). It bridges the simple encoder/decoder API that
the company's GStreamer plugin (`gstipgevsdec.c`/`gstipgevsenc.c`) expects
onto the ETSI EVS reference codec's real API.

**Not included here** (proprietary/licensed, transfer out-of-band — USB
drive, internal file share, etc. — never through this git remote):

1. The company's own GStreamer plugin source for the `ipgevs` element
   (`gstipgevsdec.c/.h`, `gstipgevsenc.c/.h`, `gstipgevsparse.c/.h`,
   `gstipgevsbase.c/.h`, `gstrtpipgevspay.c/.h`, `gstrtpipgevsdepay.c/.h`,
   `gstipgevs.c`). On the Windows dev machine these live at
   `Desktop\gstreamer\ipg-plugin\ipgevs\`.
2. The ETSI EVS reference codec source (3GPP TS 26.443, floating-point
   reference C, `lib_com`/`lib_enc`/`lib_dec`). Obtained from the ETSI
   ZIP (`ts_126443v160100p0.zip` or newer) — requires a browser
   User-Agent when curling it directly, the default UA gets a 403.

Both of the above need to sit alongside this directory (or wherever the
build script points `-I`) before any of this compiles.

## What we built on Windows (MinGW) and what changes on Mac

The Windows build used MSYS2's prebuilt `mingw-w64-x86_64-gstreamer` +
`gst-plugins-{base,good,bad,ugly}` packages (not a from-source GStreamer
build — that's Linux-autotools-oriented and far slower to port). On macOS,
the equivalent is Homebrew:

```sh
brew install gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly pkg-config meson ninja
```

This gives you `gst-launch-1.0`, `gst-inspect-1.0`, and the AMR-NB/AMR-WB/
OPUS decoders/encoders (`amrnbdec`, `amrwbdec`, `voamrwbenc`,
`opusdec`/`opusenc`) for free — only the EVS element needs to be built.

### 1. Build `libevs.a` (or `.dylib`/static `.a` — either works, we statically
   link it into the plugin)

`lib_com/typedef.h` needs a MinGW branch on Windows
(`|| defined(__MINGW32__) || defined(__MINGW64__) || defined(__GNUC__)`
added to the `__unix__` `#elif`) — **on macOS/Linux this isn't needed at
all**, since the existing `__unix__`/`__APPLE__` branch already covers it.

```sh
cd evs-src/ccode/c-code
make CC="cc -std=gnu11 -fcommon -w"
ar rcs libevs.a build/**/*.o
```

(`EVS_cod`/`EVS_dec` CLI executable linking may fail on `ntohs`/`ntohl`
socket symbols from `g192.c` — irrelevant, we only need the `.a`, not the
CLI tools.)

### 2. Build the plugin against `libevs.a` + GStreamer headers

We do **not** need the symbol-hiding/merging trick used for the SIP
sidecar's `libevs.a` (`ar d` + `ld -r --whole-archive` +
`objcopy --keep-global-symbol=`) — that was only needed there because the
SIP daemon links `libevs.a` into the SAME executable as
`libopencore-amr*.a`, which have colliding BASOP32 helper symbol names.
Here, each GStreamer element is its own shared library
(`.dll`/`.dylib`/`.so`) with a private symbol namespace, so no collision
risk even though the same colliding symbol names exist in both archives.

The company's own `gstipgevs.c` (plugin entry point) also registers RTP
pay/depay elements (`rtpipgevspay`/`rtpipgevsdepay`), which need
`gstrtputils.h` — a `gst-plugins-good`-internal header not exposed for
external plugin builds. For file-based playback (this app's use case) we
don't need those, so build a **file-codec-only** variant of the plugin
init that skips those two `gst_element_register` calls (copy
`gstipgevs.c`, drop the `#include "gstrtpipgevs*.h"` lines and the two
`rtpipgevs*` registrations — everything else is identical).

```sh
GST_CFLAGS=$(pkg-config --cflags gstreamer-1.0 gstreamer-audio-1.0 gstreamer-base-1.0)
GST_LIBS=$(pkg-config --libs gstreamer-1.0 gstreamer-audio-1.0 gstreamer-base-1.0)
EVS_INC="-I/path/to/evs-src/ccode/c-code/lib_com -I/path/to/evs-src/ccode/c-code/lib_dec -I/path/to/evs-src/ccode/c-code/lib_enc"

cc -std=gnu11 -fcommon -w -c \
  gstipgevs_filebuild.c gstipgevsbase.c gstipgevsdec.c gstipgevsenc.c gstipgevsparse.c ipgevs.c \
  $EVS_INC $GST_CFLAGS

cc -shared -o libgstipgevs.dylib \
  gstipgevs_filebuild.o gstipgevsbase.o gstipgevsdec.o gstipgevsenc.o gstipgevsparse.o ipgevs.o \
  /path/to/libevs.a \
  $GST_LIBS \
  -Wl,-undefined,dynamic_lookup   # macOS equivalent of --allow-multiple-definition, if the linker complains
```

(On Windows we needed `-Wl,--allow-multiple-definition` because `ld.exe`
is stricter about duplicate weak symbols between `libevs.a`'s object
files; the macOS/`ld64` equivalent, if it comes up at all, is usually
`-Wl,-undefined,dynamic_lookup` or just isn't needed — try without it
first.)

Install into GStreamer's plugin path so `gst-inspect-1.0 ipgevsdec` finds
it:

```sh
cp libgstipgevs.dylib "$(pkg-config --variable=pluginsdir gstreamer-1.0)/"
gst-inspect-1.0 ipgevsdec   # should show "EVS audio decoder"
```

## Adapter design notes (why `ipgevs.c` looks the way it does)

The company's `gstipgevsdec.c`/`gstipgevsenc.c` expect a simple
init/process/free API (`evs_dec_init`, `evs_dec_process`, `evs_dec_free`,
same shape for encode). The ETSI reference codec doesn't expose anything
that simple — the closest thing is the jitter-buffered `EVS_RX_*` API in
`lib_dec/EvsRXlib.h` (`EVS_RX_Open`/`EVS_RX_FeedFrame`/
`EVS_RX_GetSamples`/`EVS_RX_Close`), designed for real-time RTP use with
sequence numbers and receive timestamps. `ipgevs.c`'s decoder side just
feeds it monotonically increasing fake timestamps per-frame (20ms apart)
since we're decoding a file sequentially, not a live stream — that's fine,
`EVS_RX_*` doesn't care where the timestamps came from as long as they're
increasing.

`EVS_RX_FeedFrame` wants its `au`/`auSize` argument as an **unpacked bit
array** (one bit per array element, MSB-first) — not the packed bytes
that live in the file. `ipgevs.c` unpacks the compact-format
`[ToC][speech bytes]` frame (produced by `ipgevsparse`, matching the
`#!EVS_MC1.0\n` file header format) into that representation before
calling `EVS_RX_FeedFrame`.

Encoding has no equivalent jitter-buffer helper — `ipgevs.c` calls the raw
`init_encoder`/`evs_enc`/`indices_to_serial` API directly. Three bugs we
hit and fixed here, easy to reintroduce if this file is ever rewritten:

1. **`Encoder_State.ind_list` must be caller-allocated** (an
   `Indice[MAX_NUM_INDICES]` array) and assigned to `st->ind_list` BEFORE
   `init_encoder()` runs — the reference code just writes through
   whatever pointer is there; a null/garbage pointer causes hangs or
   memory corruption, not a clean crash.
2. **Call `reset_indices_enc(st)` before every single `evs_enc()` call.**
   The reference `encoder.c` CLI only calls it once (inside
   `init_encoder()`) because its own usage pattern is "encode until EOF,
   never re-encode a second logical stream in the same process." Without
   a per-frame reset here, `indices_to_serial()`'s output size grows
   unboundedly across calls (e.g. 264 bits → 528 → 792 → ... for
   successive 20ms frames) because the indices from every prior frame
   are still sitting in `ind_list`.
3. **The `evs_error* error;` your caller declares must be
   explicitly cleared to `NULL` by us on the success path.**
   `gstipgevsdec.c`/`gstipgevsenc.c` declare that local variable without
   initializing it, then check `if (error) { ...fail... }` — if
   `evs_dec_init`/`evs_enc_init`/etc. never touch `*err` on success, the
   caller's uninitialized stack garbage reads as a spurious failure.
   `ipgevs.c` sets `*err = NULL` at the top of every public function that
   takes an `evs_error**`, defensively, regardless of which caller has
   this bug.

Also: **EVS `codec_mode` (MODE1 vs MODE2) must be derived by the caller
from the target bitrate**, per a fixed lookup table
(`lib_enc/io_enc.c`'s `io_ini_enc()`) — `init_encoder()` itself does NOT
derive this, it only reads whatever's already set on `st->codec_mode`.
Getting this wrong doesn't produce a clean error; it causes an
ETSI-internal assertion crash deep in the DSP code
(`tcx_utils.c: "Not supported overlap"`). `codec_mode_for_rate()` in
`ipgevs.c` mirrors that table.

## Verification we did on Windows (repeat on Mac before trusting it)

- Standalone C test harness calling `evs_enc_init`/`evs_enc_process`
  directly (no GStreamer) to confirm the adapter itself works before
  debugging the GStreamer element wrapper.
- `gst-launch-1.0 audiotestsrc ! audioconvert ! audio/x-raw,rate=16000 !
  ipgevsenc bitrate=13200 ! filesink location=test.raw`, prefixed the
  output with the `#!EVS_MC1.0\n` header, then decoded it back with
  `gst-launch-1.0 filesrc ! ipgevsparse ! ipgevsdec ! audioconvert !
  wavenc ! filesink` and confirmed the resulting WAV has real (non-zero,
  coherent-looking, not just non-crashing) sample data — the exact same
  round-trip should be repeated on Mac.
- Tested both MODE1 (13200bps) and MODE2 (16400bps) bitrates end-to-end.
- Real-world caveat: every sample audio file the company provided for
  testing (`enc_test/samples/*.amrwb` etc.) turned out to have been
  corrupted by a prior UTF-8 re-encoding pass — don't use those to debug
  a "the codec is broken" symptom; generate fresh test files via
  `gst-launch`'s own encoder instead, like the round-trip above.

## Windows-specific gotcha that does NOT apply on Mac

`gst-launch-1.0` on Windows silently strips backslashes out of
`location=` property values (GStreamer's pipeline-description grammar
treats `\` as an escape character), corrupting Windows paths like
`C:\Users\...` into `C:Users...`. The sidecar code
(`electron/gstreamerSidecar.ts`) converts paths to forward slashes before
building the pipeline args to work around this. On macOS/Linux, paths are
forward-slash-native already so this conversion is a no-op — no separate
fix needed there, but don't remove the `toGstPath()` call, since it's
also correct (and necessary) for the Windows build.
