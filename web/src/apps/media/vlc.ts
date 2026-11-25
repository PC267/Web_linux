// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// VLC: the media player's development version (VLC 4), whose Qt 6 interface
// and video windows are Wayland's own, as a window on the page (Debian).
// Debian's VLC 3 has no Wayland interface, and there is no package of VLC 4
// for Debian: vlc.sh takes VideoLAN's daily build for Ubuntu 26.10 arm64
// (Launchpad, ~videolan/master-daily), the newest at the first run or at
// `./vlc.sh update`, with every library it needs from Ubuntu 26.10 itself,
// glibc included (PACKAGES, below: the release pocket's packages, pinned by
// SHA-256; the daily build's by the SHA-512 of its index, and that by the PPA's
// signature, KEY below, with apt's verifier, sqv).
// They are unpacked into ~/.apps/vlc/root (526 MiB), never installed: no
// package script runs, nothing needs root, and deleting the directory
// removes it all.
//
// The page fetches the libraries (`bundle`, 140 MiB: from its mirror, else
// plain http over its own Wisp connection, ports.ubuntu.com sends no CORS
// headers) and pushes the packages into debs/; vlc.sh checks them, fetches
// what is missing itself and unpacks them (16 s; the push 1 s: CLI,
// 2026-11-25). The daily build (10 MiB, unpinned) is the guest's own
// download. Both downloads of vlc.sh ask the page's mirror first where the
// page routes it, then the upstreams, all plain http: the checks above are
// what makes that safe (and Launchpad's https answered more than half of
// the requests with 503 after 5 s, its http none: 2026-11-25).
//
// VLC runs through that tree's own ld.so (--inhibit-cache --library-path), so
// it never takes the system's libraries while the tree has them, and no
// LD_LIBRARY_PATH reaches another program. (ld.so still ends at the system's
// library directory: vlc.sh deletes the plugins whose libraries the tree
// leaves out, or they would take Debian's, VLC 3's for one.) What the libraries look up by
// absolute path is named by environment variables (Qt plugins and QML, Mesa's
// EGL vendor file and drivers, xkb, ALSA, fontconfig). The helpers VLC
// executes (vlc-qt-check: without it there is no Qt interface) get wrappers
// that go through the same ld.so. The VA driver is the kw layer's. Its
// settings are in ~/.apps/vlc/home.
//
// Qt Quick renders with GL through virgl, which Mesa is told to call GL 3.0
// (the guest's is 2.1: six of VLC's pipelines do not build on it, seen on
// llvmpipe held to 2.1, 2026-11-25); without /dev/dri it takes Qt's
// software renderer, since llvmpipe is too slow under the video. Decoding is
// the kw layer's VA-API with /dev/dri (VLC_HW=0: software; VLC falls back to
// it by itself for what the driver refuses).
//
// The daily packages leave out their library dependencies, which is why the
// list is ours: a later build can need a library it lacks, which vlc.sh says.
import type { TerminalApp } from "../types.ts";

const UBUNTU = "http://ports.ubuntu.com/ubuntu-ports";
/** The daily builds' PPA, below Launchpad's host and the mirror's /ppa. */
const PPA = "videolan/master-daily/ubuntu";
/** The page's mirror (config.ts DEFAULT_ROUTES), and its copy of UBUNTU. */
const MIRROR = "mirror.unkernel.dev";
const UBUNTU_MIRROR = "/ports/ubuntu-ports";
/** The library list's version: root/.got/libs in the guest. */
const LIBS = "2026-11-25";

const VLC = String.raw`#!/bin/bash
# VLC 4's daily build in this directory, with its own libraries:
#   ./vlc.sh [FILE|URL...]   run it (the first run unpacks it)
#   ./vlc.sh update          take the newest daily build
set -e -o pipefail
D=$(cd "$(dirname "$0")" && pwd)
cd "$D"
P=$D/root L=$D/root/usr/lib/aarch64-linux-gnu
export LC_ALL=C.UTF-8
mkdir -p root/.got debs tmp home/config home/data home/cache
say() { printf '\033[1m%s\033[0m\n' "$*"; }

# bases: where the packages are, in the order they are asked (UBU, PPA). The
# page's mirror is first where the page routes its name (it then resolves into
# 198.51.100.0/24): plain http to it is answered by the page's own fetch() and
# not carried over the network relay.
bases() {
	UBU=(${UBUNTU}) PPA=(http://ppa.launchpadcontent.net/${PPA})
	case $(getent hosts ${MIRROR} 2>/dev/null | sed -n '1s/[[:space:]].*//p') in
	198.51.100.*)
		UBU=(http://${MIRROR}${UBUNTU_MIRROR} "${"$"}{UBU[@]}")
		PPA=(http://${MIRROR}/ppa/${PPA} "${"$"}{PPA[@]}")
		;;
	esac
}

# get TOOL LIST BASE...: the packages of LIST ("SUM PATH" lines, below each
# BASE) into debs/, those that are not there with their checksum, several at
# once; what one BASE does not have is asked of the next.
get() {
	local tool=$1 list=$2 bad base
	shift 2
	awk '{ n = $2; sub(/.*\//, "", n); print $1 "  debs/" n }' "$list" >tmp/sums
	for base in "$@"; do
		bad=$("$tool" --quiet -c tmp/sums 2>/dev/null | sed -n 's/: FAILED.*//p') || true
		[ -n "$bad" ] || return 0
		printf '%s\n' "$bad" >tmp/bad
		xargs -d '\n' rm -f <tmp/bad
		awk -v base="$base" 'NR == FNR { bad[$0] = 1; next } { n = $2; sub(/.*\//, "", n); n = "debs/" n; if (n in bad) printf "url = \"%s/%s\"\noutput = \"%s\"\n", base, $2, n }' tmp/bad "$list" >tmp/curl
		say "Downloading $(wc -l <tmp/bad) packages from $(cut -d / -f 3 <<<"$base")"
		curl -fL -Z --parallel-max 8 --retry 3 -K tmp/curl || true
	done
	"$tool" --quiet -c tmp/sums >/dev/null 2>&1 || { echo "Some packages did not arrive: run it again to get the rest." >&2; exit 1; }
}

# unpack LIST: the packages of LIST from debs/ into root/.
unpack() {
	local sum path f i=0 n
	n=$(wc -l <"$1")
	while read -r sum path; do
		i=$((i + 1)) f=${"$"}{path##*/}
		printf '\r\033[KUnpacking %d of %d: %s' "$i" "$n" "${"$"}{f%%_*}"
		dpkg-deb --fsys-tarfile "debs/$f" </dev/null | tar -x --no-same-owner -C root --exclude='./usr/share/doc' --exclude='./usr/share/man' --exclude='./usr/share/locale'
	done <"$1"
	printf '\r\033[KUnpacked %d packages\n' "$n"
}

libs() {
	[ "$(cat root/.got/libs 2>/dev/null)" = ${LIBS} ] && return
	awk '{ print $1, $3 }' packages.txt >tmp/libs
	bases
	get sha256sum tmp/libs "${"$"}{UBU[@]}"
	unpack tmp/libs
	echo ${LIBS} >root/.got/libs
	rm -f debs/*
}

# index BASE: the daily builds' index below BASE into tmp/Packages, if the PPA
# signed it (a key of all of VideoLAN's PPAs: Origin says which).
index() {
	local d=$1/dists/stonking sum
	rm -f tmp/InRelease tmp/Release tmp/Packages tmp/Packages.gz
	curl -fsSL --retry 3 -o tmp/InRelease "$d/InRelease" || return 1
	curl -fsSL --retry 3 -o tmp/Packages.gz "$d/main/binary-arm64/Packages.gz" || return 1
	sqv --keyring ppa.asc --cleartext --output tmp/Release tmp/InRelease >tmp/sqv.log 2>&1 || { echo "$d/InRelease is not signed by the PPA's key:" >&2; cat tmp/sqv.log >&2; return 1; }
	grep -qx 'Origin: LP-PPA-videolan-master-daily' tmp/Release || { echo "$d is another PPA's" >&2; return 1; }
	sum=$(awk '/^[^ ]/ { f = $1 == "SHA512:"; next } f && $3 == "main/binary-arm64/Packages.gz" { print $1 }' tmp/Release)
	echo "$sum  tmp/Packages.gz" | sha512sum --status -c - || { echo "$d: the index is not the one signed" >&2; return 1; }
	gzip -dc tmp/Packages.gz >tmp/Packages
}

daily() {
	local v h f missing base ok=
	say "Looking for the newest daily build"
	bases
	for base in "${"$"}{PPA[@]}"; do
		if index "$base"; then ok=1; break; fi
	done
	[ -n "$ok" ] || { echo "The daily builds' index did not arrive: run it again." >&2; exit 1; }
	v=$(awk 'BEGIN { RS = ""; FS = "\n" } $1 == "Package: vlc" { for (i = 2; i <= NF; i++) if ($i ~ /^Version: /) print substr($i, 10) }' tmp/Packages | sort -V | tail -n 1)
	[ -n "$v" ] || { echo "No VLC in the daily builds' index" >&2; exit 1; }
	[ "$v" != "$(cat root/.got/version 2>/dev/null)" ] || { echo "VLC $v is the newest"; return; }
	say "VLC $v"
	awk -v v="$v" 'BEGIN { RS = ""; FS = "\n" }
		$1 ~ /^Package: (vlc|vlc-bin|vlc-data|libvlc[0-9]+|libvlccore[0-9]+|libvlc-bin|vlc-plugin-base|vlc-plugin-qt|vlc-plugin-video-output)$/ {
			ver = f = s = ""
			for (i = 2; i <= NF; i++) { if ($i ~ /^Version: /) ver = substr($i, 10); if ($i ~ /^Filename: /) f = substr($i, 11); if ($i ~ /^SHA512: /) s = substr($i, 9) }
			if (ver == v) print s, f
		}' tmp/Packages >tmp/daily
	get sha512sum tmp/daily "${"$"}{PPA[@]}"
	rm -rf root/.got/version "$L/vlc" root/usr/share/vlc "$L"/libvlc*
	unpack tmp/daily
	say "Setting it up"
	# The helpers VLC executes, through the same ld.so as VLC.
	for h in vlc-preparser vlc-qt-check vlc-cache-gen; do
		f=$L/vlc/libexec/vlc/$h
		[ -f "$f" ] || continue
		mv "$f" "$f.bin"
		printf '#!/bin/sh\nexec "$VLC4_LD" --inhibit-cache --library-path "$VLC4_LP" --argv0 "$0" "$0.bin" "$@"\n' >"$f"
		chmod 755 "$f"
	done
	# The plugins whose libraries are not in packages.txt go: by name those it leaves out (else they take
	# the system's where it has them), then any other that does not load (else each start names it).
	find "$L/vlc/plugins" -name '*_plugin.so' | grep -E '/lib([a-z_]*_)?(pipewire(src|list)?|pulse(src|list)?|avahi|upnp|lirc|mod|dc1394|linsys_[a-z]+|rist|aribsub|svgdec|x264(10b)?|x265|xcb_hotkeys|qt_gtktheme|chromaprint|(glinterop_)?vdpau(_[a-z]+)?)_plugin\.so$' | xargs -r -d '\n' rm -f
	"$VLC4_LD" --inhibit-cache --library-path "$VLC4_LP" --argv0 vlc root/usr/bin/vlc --version >tmp/plugins.log 2>&1 || true
	sed -n 's/.*cannot load plug-in \(.*_plugin\.so\):.*/\1/p' tmp/plugins.log | sort -u | xargs -r -d '\n' rm -f
	"$L/vlc/libexec/vlc/vlc-cache-gen" "$L/vlc/plugins" >>tmp/plugins.log 2>&1 || true
	missing=$("$VLC4_LD" --inhibit-cache --library-path "$VLC4_LP" --list "$L/vlc/plugins/gui/libqt_plugin.so" 2>&1 | grep -E 'not found|error while' || true)
	[ -z "$missing" ] || { echo "This build needs a library packages.txt lacks:" >&2; echo "$missing" >&2; }
	echo "$v" >root/.got/version
	rm -f debs/*
}

export VLC4_LD=$L/ld-linux-aarch64.so.1
export VLC4_LP=$L:$L/vlc:$L/pulseaudio:$L/libproxy:$L/blas:$L/lapack
export VLC_PLUGIN_PATH=$L/vlc/plugins GCONV_PATH=$L/gconv
export QT_PLUGIN_PATH=$L/qt6/plugins QML_IMPORT_PATH=$L/qt6/qml QML2_IMPORT_PATH=$L/qt6/qml QT_QPA_PLATFORM=wayland
export __EGL_VENDOR_LIBRARY_DIRS=$P/usr/share/glvnd/egl_vendor.d LIBGL_DRIVERS_PATH=$L/dri GBM_BACKENDS_PATH=$L/gbm
export LIBVA_DRIVERS_PATH=/usr/lib/aarch64-linux-gnu/dri
export XKB_CONFIG_ROOT=$P/usr/share/X11/xkb ALSA_CONFIG_PATH=$P/usr/share/alsa/alsa.conf ALSA_CONFIG_DIR=$P/usr/share/alsa
export XDG_CONFIG_HOME=$D/home/config XDG_DATA_HOME=$D/home/data XDG_CACHE_HOME=$D/home/cache FONTCONFIG_FILE=$D/home/fonts.conf
if [ -e /dev/dri/renderD128 ]; then
	# Guest GL is GL 2.1, for which Qt and VLC have no shaders for some of the interface: say 3.0.
	export MESA_GL_VERSION_OVERRIDE=${"$"}{MESA_GL_VERSION_OVERRIDE-3.0} MESA_GLSL_VERSION_OVERRIDE=${"$"}{MESA_GLSL_VERSION_OVERRIDE-130}
else
	export QT_QUICK_BACKEND=software
fi
echo "<?xml version=\"1.0\"?><fontconfig><dir>$P/usr/share/fonts</dir><cachedir>$D/home/cache/fontconfig</cachedir></fontconfig>" >"$FONTCONFIG_FILE"

libs
if [ "$1" = update ]; then daily; exit 0; fi
[ -e root/.got/version ] || daily
cd "$OLDPWD"
hw=--no-hw-dec
[ ! -e /dev/dri/renderD128 ] || [ "$VLC_HW" = 0 ] || hw=--hw-dec
# A session bus of its own (its D-Bus interface and screensaver inhibition ask for one).
exec dbus-run-session -- "$VLC4_LD" --inhibit-cache --library-path "$VLC4_LP" --argv0 vlc "$P/usr/bin/vlc" --no-qt-privacy-ask --aout alsa $hw "$@"
`;

export default {
	id: "vlc",
	title: "VLC",
	desc: "The VLC media player's development version (VLC 4, a daily build), in a window on the page (a large download)",
	// The VLC media player logo, from Simple Icons (CC0 1.0), slug vlcmediaplayer.
	icon: { svg: '<path d="M12.0319 0c-.8823 0-1.0545.136-1.0545.136-.1738.056-.3556.255-.4105.43L9.683 3.3808c.4729.1729 1.3222.4266 2.2337.4266 1.0987 0 2.017-.3494 2.3763-.5075L13.4352.566c-.055-.1755-.237-.3707-.4067-.4374 0 0-.1142-.1286-.9966-.1286zm3.5645 7.455c-.3601.34-1.3276.9373-3.6797.9373-2.2929 0-3.189-.5678-3.5213-.9113l-1.3887 4.4227c.2272.3614 1.2539 1.5594 4.8847 1.5594 3.7569 0 4.8539-1.3467 5.0649-1.6737zm-8.5897 4.4487l-1.0025 3.1922H4.3428c-.2486 0-.5097.1932-.5826.4315l-2.334 7.6317a.3962.3962 0 0 0-.0169.1537c-.0008.0053-.002.0099-.002.016 0 .0839.0233.226.0233.226.0322.2456.2612.4452.5098.4452h20.1192c.2487 0 .4768-.1994.5098-.4453 0 0 .0234-.142.0234-.226a.0245.0245 0 0 0-.0025-.01.3201.3201 0 0 0 .0024-.0313.4096.4096 0 0 0-.019-.1282l-2.3339-7.6318c-.0729-.2383-.334-.4314-.5826-.4314h-1.6636l.2005.6391c-.2407.4854-1.4886 2.38-6.3027 2.38-4.6003 0-5.8288-1.73-6.1107-2.3072z"/>' },
	colors: ["#ff8800", "#9a3412"],
	needs: { net: true, wayland: true },
	packages: { debian: ["curl", "ca-certificates", "dbus-daemon", "sqv"] },
	bundle: {
		path: "debs",
		unless: `[ "$(cat root/.got/libs)" = ${LIBS} ]`,
		files: async () => PACKAGES.trim().split("\n").map((l) => {
			const [sha256, size, path] = l.split(" ") as [string, string, string];
			return { url: `${UBUNTU}/${path}`, mirror: `https://${MIRROR}${UBUNTU_MIRROR}/${path}`, sha256, size: Number(size) };
		}),
	},
	files: async () => ({
		"vlc.sh": { content: VLC, mode: 0o755 },
		"packages.txt": PACKAGES,
		"ppa.asc": KEY,
		"README": "VLC 4's daily build, with its own libraries in ./root (delete it to remove them).\n" +
			"  ./vlc.sh FILE|URL            play something\n" +
			"  ./vlc.sh update              the newest daily build\n" +
			"  VLC_HW=0 ./vlc.sh FILE       decode in software\n",
	}),
	commands: ["./vlc.sh"],
} satisfies TerminalApp;

// The PPA's signing key (Launchpad PPA for Videolan), fingerprint
// 9B9881E64826CD6717BD62584792F0D24EAE4AD4 as Launchpad's API names it.
const KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

xsFNBGYzlYoBEAC/lK3lAmF0tQLYQ844PC6bq3kCzS+i8scDE+zhcWSfUe45tuo4
Vysl/sJo1eHytApkoz+gGsaaia3mulvSTGJ6TXA6exTWwT2PWhKh1cGQHQWc8mRG
fn8jwBDkxAfjyxRfjDas5STJMA9NUqsOZ4SCGZ38BV6w24qvrm3SeYuUgopR5aSj
I2X5Ki9P3BPflTDZrlh/wnlyZgotnmO7D+EuArE4WWw2bTpotC1LjSBKveeAQW1R
hIwsqkmIDAVsczfbGNvE+sux0vA33cer2Y0C7jqJbxtsN1p9zfbSMzutgVl/ZD2j
nHim3RnASoFNeiIchAIsdgosDPvQSjE4pmalyLXSNaa9rFEV4QnxwAIZ9DYniuzD
+YlwRWL2coEzK5JClkluBQ89r5Mnm2z/jSiFRHNH2giUJZm4kuEe+GWJtgMBi6yy
7wvE2Z7UfKjz5bYJbGLgZAX5wtycaxdre6ijyXy78wDxHaAF0HqPRe+fZ5jeGG35
AEqg6BrTTs75ME1HqHdePXUbyikxsBn2hDNRSk/I16s3fAL3kYSOsLMyXEizHWYo
Yz4lDffHzVNsICP5Blc/Ywu8JOb39ZHqBuKLmms5zK2aWQzuwye/essuIRFajAKJ
VtH7yc2cNFi0x35I3dgfFWQ6JDs/2x/mW1/i7vTwRme8SuzWIUtTVy1V+QARAQAB
zRpMYXVuY2hwYWQgUFBBIGZvciBWaWRlb2xhbsLBjgQTAQoAOBYhBJuYgeZIJs1n
F71iWEeS8NJOrkrUBQJmM5WKAhsDBQsJCAcCBhUKCQgLAgQWAgMBAh4BAheAAAoJ
EEeS8NJOrkrUNnoP/1muBT6nFB8p7lGgAyyztf4BFzHXXg3ozYSYds7YtAElJLSw
5J4FZm3PuY6YIEFNtx+b2qkHA8Eaf0iu3O0QXERPrt5vhWwvireYWk6WuXj7V2Nb
xJQpwyBcFDWVM+/YSTyJUYF6fWm7y1RSWjamUwTAqtKABu/VHHc3kU4mUDhVZB+P
Tbu2uM/XdbiSyKGI0OPYMtQka8lE8SARW2Y+ySIj3E5kwMNldBJ/ERv9kIfaBVg8
TmEzuSP0eh+PtsvFNhGaI2oXXTOfkyTHyKdso8f+Wxd/8umN9e6i3oxJD4g8jvIu
0tM5u9kMHddcvGnhCjfPVkOlfS5xRbM/tMwcb9ZTgkEdmny0x9XToRLxkTyqQM7o
nHMvjshFzwdf0hAVoG9I5PReMyjIp6Tu+itfQttjP55QggNgrUoFmBhCj0dEXpSJ
QS2TX6Uu+uwHMQ28skjqp3l3/oCh+x1E7M22QDb435jrPXsDTxmZ6SAPL9ResfYU
oqf6CInxHxQjfRG/Kiwp6Htlc13ztCXERBeW0gloU5EvcS1c6lb2tjA8MQbQLjea
mM9jbCXvTh3stlDU0UQ78yj7HODxoVAbo9mjiriE4g7WCPmGiALZjDR+4FqM+GpZ
Tmtf5Brje1qySznxZIs2Lae2YFcHNEhaJ2jfApDfthkk5YaHIKLyAxgsYgDv
=G0L2
-----END PGP PUBLIC KEY BLOCK-----
`;

// What the daily build needs from Ubuntu 26.10 arm64, one "SHA256 SIZE PATH"
// line per package, PATH below UBUNTU: the packages with a library that its
// programs, plugins (a few optional ones left out), Qt plugins and QML
// modules, or Mesa's drivers load, and the data they read (2026-11-25). A
// change to the list is a change to LIBS.
const PACKAGES = `7901b46b02fa2e40ecbb5a64497fc177d5b38738e6151eb2076847a6b2f2ae28 37522 pool/main/f/fontconfig/fontconfig-config_2.17.1-5ubuntu1_arm64.deb
7b09b1b21ef6b234c157ecddba684a43996a3eb6d196e8e6711b40c9f7ed7dc9 834146 pool/main/f/fonts-dejavu/fonts-dejavu-core_2.37-9_all.deb
5d9b877f8a21eb56d3edb210095715c1063c7af0cd814bc59cde121a33658d70 20196 pool/main/a/acl/libacl1_2.4.0-1_arm64.deb
9181e0676a35ddf3fa18cb9d3a86041c09d78c1b7831a647741c0e48ca31036d 1805470 pool/main/a/aom/libaom3_3.14.1-1_arm64.deb
4f27bfda191ff4727cf8d3609fdf6c17e8dc20e971b6098571df3e3fb106b45d 391638 pool/main/liba/libarchive/libarchive13t64_3.8.9-1_arm64.deb
5d1120a75b7812f80dd1b7dcc5554f27dd161d63105e6fdb71d8d9992678cc91 30124 pool/universe/a/aribb24/libaribb24-0t64_1.0.3-3_arm64.deb
0c0031720fcef8c64615b96eb63fb7b600db350f1a01956faaf288500dcd69b5 19378 pool/main/a/alsa-lib/libasound2-data_1.2.16.1-1_all.deb
287fda0d77d36041edd6807fd179a3b14e9f610afe331be8447d2c0e96cddd8c 401714 pool/main/a/alsa-lib/libasound2t64_1.2.16.1-1_arm64.deb
8824b5c9eb4625397f95cca8d39e969f17a67d18539c1971c2fb5ada0eb1bb85 102362 pool/universe/liba/libass/libass9_0.17.5-1_arm64.deb
a7f569beab03f69ccb3579f1c8e950c27c0db178d7a3146f099a31230a624e50 11098 pool/main/g/gcc-16/libatomic1_16.2.0-3ubuntu1_arm64.deb
31540ccf8e338bfa16922f033abdeba575f2754defd6ecd458937b158b598f16 16036 pool/universe/liba/libavc1394/libavc1394-0_0.5.4-6_arm64.deb
701b0adc7de9d8cc6cb03cad92249395c8bf72a4aca06909fbb886ec88df0db5 6912102 pool/universe/f/ffmpeg/libavcodec62_8.1.2-2ubuntu2_arm64.deb
e1bd9e7b1da305e29dae1723f7c62b733988188987447d7d1ada73aca4536d7c 1322688 pool/universe/f/ffmpeg/libavformat62_8.1.2-2ubuntu2_arm64.deb
c5945d3855c3b5d8d8024934d5784cf6ce69567273e19cdbbb5eac8243628667 427044 pool/universe/f/ffmpeg/libavutil60_8.1.2-2ubuntu2_arm64.deb
216f8fae79da4601a956d4a710f25cb75a687944336f1887ea66120a8e5d1ee7 18904 pool/universe/libb/libb2/libb2-1_0.98.1-1.1build2_arm64.deb
958a534696bdab4d1b65c040bd86c6145d629b6e027f74194fe4df04b97010f5 129210 pool/main/u/util-linux/libblkid1_2.42.2-1ubuntu2_arm64.deb
6129361ff0b51bf0a564075aa5ff1db659975d751f878edf39d383d1fbf9e058 129798 pool/universe/libb/libbluray/libbluray4_1.5.0-3_arm64.deb
3e54ce0152fd8208c4dbe23fa3cce7372efbbe0ffaa70d7f116e44183d98d295 344502 pool/main/b/brotli/libbrotli1_1.2.0-4_arm64.deb
df5ae01600938a7defd6adb3815953ea826ade066ad71b099bba9122f67303df 42224 pool/main/libb/libbsd/libbsd0_0.12.2-3_arm64.deb
206a6ef6e7bacf4a36cbf7bce75f6a0afa22b17c66cffc073a9a6f94e2cd68a3 34914 pool/main/b/bzip2/libbz2-1.0_1.0.8-6build2_arm64.deb
99b3a6ef27bb5ea01b6651bebce626afce3498b6129a19ec6a44dee33733e339 1669562 pool/main/g/glibc/libc6_2.44-1ubuntu2_arm64.deb
b23ae4a4e60a0212f82c3b08b84810a53df33ed458b420c222a35d05f8d6d66c 127358 pool/main/c/cairo/libcairo-gobject2_1.18.4-3_arm64.deb
5ea92d9d5a23668872c99b3d79ae7e3b0f9391d70532c9c2aeeddb8a6e776bcb 555750 pool/main/c/cairo/libcairo2_1.18.4-3_arm64.deb
c89cf24d568720b3a434c86dd1248e868268382cc5480f8f61f00f2942b8b200 25344 pool/main/libc/libcbor/libcbor0.10_0.10.2-2.1ubuntu1_arm64.deb
3f522e33246dde39a7c6fdba6d41824e9a0c975450a48e32380a80f22876c4ae 31472 pool/universe/c/chromaprint/libchromaprint1_1.6.1-1_arm64.deb
87e25c1d8c726f8ea2f2b7eb023d190d52328d9b1dcdfa4acfbc08e7c5ab1dbb 22304 pool/universe/c/cjson/libcjson1_1.7.19-2_arm64.deb
79b054fd2945f1452aa9a24c75db53d72c572284ed81dc6b02509b2acc83af54 9003470 pool/universe/c/codec2/libcodec2-1.2_1.2.0-5_arm64.deb
49a667f62f45c1916cf4a93d8c296f1e8ba9f60a5677bcdf4d837c975331e1bc 19790 pool/main/e/e2fsprogs/libcom-err2_1.47.4-1_arm64.deb
f97aa0890c100b6a05680fcd23f21e892cff0e72bb069f4b26531a885263f1a9 410946 pool/main/c/curl/libcurl3t64-gnutls_8.20.0-2ubuntu11_arm64.deb
18a052d745b66ca019a1f5e4579d84a53819ff6730197e3742017cefca9ff002 19074 pool/main/libd/libdatrie/libdatrie1_0.2.14-2_arm64.deb
a82162d5013f58e57e0d29dd684bf7d0d227ca3bbe734d9c10313338fd735c93 321506 pool/universe/d/dav1d/libdav1d7_1.5.4-1_arm64.deb
6e356d5d382ece48127942781f133569461ac5bbedd55a06adbdc982d85c7cc0 179972 pool/main/d/dbus/libdbus-1-3_1.16.2-5ubuntu2_arm64.deb
87e599f275fba0c9a919b0c1d2b63f97f3e16a0696a0efb303ee87cfdc623e4f 39070 pool/universe/d/double-conversion/libdouble-conversion3_3.4.0-1_arm64.deb
56570bf50a4607aa85bb2fafb791d99949b10318683f5f28305ece2f44b2d8cd 22872 pool/main/libd/libdrm/libdrm-amdgpu1_2.4.134-3_arm64.deb
0cae4a50e065fed26dfbd408feaba905742ca5714a048eb0514f82052ecd0264 8380 pool/main/libd/libdrm/libdrm-common_2.4.134-3_all.deb
93e5da06aadf2cdb15043048b70ebd36bb7bdba732bcff3cfc497cf868a46b6c 41396 pool/main/libd/libdrm/libdrm2_2.4.134-3_arm64.deb
fc34385eed12d7fdd4cd4df897cfa7f5372637db23cf0774e2cae11ad60c2eaf 144414 pool/main/d/duktape/libduktape207_2.7.0+tests-0ubuntu4_arm64.deb
73d85db383f15dd37d11f1ebc3a68ec9cf960f43b14300dd9acb509e9bf29b89 48054 pool/universe/libd/libdvbpsi/libdvbpsi10_1.3.3-2_arm64.deb
4bedff36a6b5dc7fd38a237ba5308657e4ae87b7e52fa0676111e2d3c63d53cf 37808 pool/universe/libd/libdvdnav/libdvdnav4_7.0.0-2_arm64.deb
4aa7ff4fa519e912b36fd3eef66d9da2ffe0b0bdad4257ad26e4f5a137d39952 67068 pool/universe/libd/libdvdread/libdvdread8t64_7.1.1-1_arm64.deb
d26eb9e5390ac429b0ea429e03b09ff936099e02738544d66dcd5eb16957edeb 48030 pool/universe/libe/libebml/libebml5_1.4.7-2_arm64.deb
b7836732019aef5c554e4a45600e5e521f41aaeccb625106675e1cc4ed6ff0d3 96292 pool/main/libe/libedit/libedit2_3.1-20260512-1_arm64.deb
2ebc1fddfaca8fad15210db930bd2402b611cd8e13c5d0a9deb97fb7a3da69ac 124778 pool/main/m/mesa/libegl-mesa0_26.2.4-1ubuntu1_arm64.deb
1cefa36464c8ab3043ba2f82c3daa18ce591dc4c2a37d09e3c47b1f2fa880dc6 29722 pool/main/libg/libglvnd/libegl1_1.7.0-3_arm64.deb
87faa13a688092150515e659ef2371a472b604ed9816884be4ad1221f5858848 57662 pool/main/e/elfutils/libelf1t64_0.196-1_arm64.deb
e33c3239f01872aedb3e94c510b2b3233bca22bf7ca5b36321f9ab5a5aa98e8e 34264 pool/main/libe/libevdev/libevdev2_1.13.6+dfsg-3_arm64.deb
391336a526a309d4ba2e910afecfd8bbfd5200958cd87642b61ddb3397150b42 85500 pool/main/e/expat/libexpat1_2.8.3-1ubuntu1_arm64.deb
9db083631c11e05a1d0b5ecf1f5f5a64bfcb428651958bfab6ce827da79e86d0 208166 pool/universe/f/faad2/libfaad2_2.11.2-1build1_arm64.deb
9f99a509c08b3f147e13bea23473b9d1aa205f92771eecc53c268fc1fe360681 26466 pool/main/libf/libffi/libffi8_3.8.0-2_arm64.deb
32d5697c2f76a3a7f97c880b2a947694ae74f2cd3184999a64da450394c04ac8 85170 pool/main/libf/libfido2/libfido2-1_1.17.0-2build1_arm64.deb
25f12a5187f301a3248d998c2bd06828bb66015a90232365b5b7be2f08673c4f 141358 pool/main/f/flac/libflac14_1.5.0+ds-5_arm64.deb
dfc15a06d372973079d2fbf97ee8741c360430e5e8d855b5dc788b479c161c37 143992 pool/main/f/fontconfig/libfontconfig1_2.17.1-5ubuntu1_arm64.deb
777612240d510cfbeadf8ac2f0bab8063a790916a7ede75a1aa782d2dfe26b63 398640 pool/main/f/freetype/libfreetype6_2.14.3+dfsg-2ubuntu1_arm64.deb
5f359a93f44fa0e837277541c7780485f479105c030afbe24f4a0eb7deced215 26974 pool/main/f/fribidi/libfribidi0_1.0.16-5_arm64.deb
41c244d7939a89393af65336a44536660e25c091c04f232ae34423865db4e325 42968 pool/main/m/mesa/libgbm1_26.2.4-1ubuntu1_arm64.deb
5f3147f93cae6c46094213b16be5fc87b55bf6e65b4d75020a53d81a26dee2b2 60982 pool/main/g/gcc-16/libgcc-s1_16.2.0-3ubuntu1_arm64.deb
d96c7a06c464767fb24497ec9f90a5963e9dcccb8c004b203b185179ea9d50a0 575854 pool/main/libg/libgcrypt20/libgcrypt20_1.12.2-1ubuntu2_arm64.deb
2803186624f4ee8f9a6ce7cf62cab05e25e334d93f0ca2b8adc24a19fbf10550 101268 pool/main/g/gdk-pixbuf/libgdk-pixbuf-2.0-0_2.44.8+dfsg-1_arm64.deb
730d556bcdc978b65adecb4868ade95130201224af7ed9e55f48fc3eda2df717 101570 pool/main/libg/libglvnd/libgl1_1.7.0-3_arm64.deb
836f35c02713a69db0cabbf6bcf66a0d5a158894c8f05f823661641a3361fa96 29398 pool/main/m/mesa/libgl1-mesa-dri_26.2.4-1ubuntu1_arm64.deb
757eb4ceda29fda07273d21d8f5707b6a1af7dd3553bf11d1bde7cd519a64236 17846 pool/main/libg/libglvnd/libgles2_1.7.0-3_arm64.deb
6d3982f513850849a56f1eab31c6b59ea7c48d68ec3aae1137886625e06e51b7 1579122 pool/main/g/glib2.0/libglib2.0-0t64_2.90.0-1_arm64.deb
6881ac107fb88b7133aaf68cd346bc656ce30bd930a08a06471a3461da5d3e26 57946 pool/main/libg/libglvnd/libglvnd0_1.7.0-3_arm64.deb
ce0913bbd613d0abe764c5f8ccd1720fc76b0e13d4506095ac3472c257467a3b 119100 pool/main/m/mesa/libglx-mesa0_26.2.4-1ubuntu1_arm64.deb
9faaf5467b6ee9fd34ad5f847ae80137c03c133ac98491588a9eb5e8d3c27eb0 33030 pool/main/libg/libglvnd/libglx0_1.7.0-3_arm64.deb
783f9c800c4f2aec4eb1d64681b7d6f359c05fc7afe00dbbc2af6ee805484939 1615822 pool/main/g/glycin/libglycin-2-0_2.2.1+ds-1ubuntu2_arm64.deb
97bd8f76bebe61d89586048b155b171c99c181690def6d98c14cafec22ddf82e 140430 pool/universe/g/game-music-emu/libgme0_0.6.4-1_arm64.deb
d7e393a6f350c62c4ca009a61e176824d2b97ceab211797eacde06d98eeb6749 258028 pool/main/g/gmp/libgmp10_6.3.0+dfsg-5ubuntu2_arm64.deb
f13552e694a28025a65333be80a2b5b8e6a45364a236791014d8c4389f652665 970398 pool/main/g/gnutls28/libgnutls30t64_3.8.13-1ubuntu1_arm64.deb
00dbceb70f46f688b0fe98295c63a1648c7b03e16840abbd84e63fec1e0bcfb2 154072 pool/main/g/gcc-16/libgomp1_16.2.0-3ubuntu1_arm64.deb
ef116ff282fb67aee2c6046e66dd179d87b788c37ef22e041e1d016c423b9491 81398 pool/main/libg/libgpg-error/libgpg-error0_1.61-3_arm64.deb
8bea695a73ef2d7b79845c2c6ae7a8a3aaf89a506219488782afc0a4338dc622 70750 pool/main/g/graphite2/libgraphite2-3_1.3.15-2_arm64.deb
4fa233b0ea9fbd60b2b9637b7431e73f7d21afec20f85bfdb8ba988120ae8d02 26120 pool/universe/libg/libgsm/libgsm1_1.0.24-1_arm64.deb
a49dd04cc05eb128799df9767f8aba9c8144d0a03e0e650015ba0601db91f28f 143000 pool/main/k/krb5/libgssapi-krb5-2_1.22.1-3ubuntu2_arm64.deb
59187dafd345c4369883a5ad47874a16247c078f7272e7a10bd1c7222bf697d5 15450 pool/main/libg/libgudev/libgudev-1.0-0_238-7build1_arm64.deb
95e817f1079eea2bc15d685a9d37e6bc9374188ecdaa588981b60c380d65c6b8 510306 pool/main/h/harfbuzz/libharfbuzz0b_12.3.2-2_arm64.deb
d6b297d01eb4a37a5f5277f8285221567c54537c20d730fc5f5c4bde72ffd2ce 199520 pool/main/n/nettle/libhogweed6t64_3.10.2-1_arm64.deb
3c5cd77da59963fbcc766dd2d1e1f3bea3c171d8dcb0d71c2303d06b7ab762a8 514490 pool/main/h/highway/libhwy1t64_1.3.0-5.1ubuntu1_arm64.deb
c4c1771030d364b679cb8dfe67b51ddaa65d9e51377895d37b5cf3b14e02c87a 42984 pool/main/libi/libice/libice6_1.1.1-1build1_arm64.deb
5675f0a3687c52713cd00533bc7fe90711020c665bf4cde3fde8cdf046d63b7f 11352170 pool/main/i/icu/libicu78_78.3-2ubuntu1_arm64.deb
8e0d58bade4d3f80368ce91cfbcd0205e90517cef7ab437f6f5cb2e56e2c15d2 57188 pool/main/libi/libidn/libidn12_1.44-1_arm64.deb
e70fa422d165428a38a237ad9dceb3d2eba3687efbe1578a40f18eae41ea38b7 67072 pool/main/libi/libidn2/libidn2-0_2.3.8-5_arm64.deb
731fc5ab0b665eaa300ff6ba9c3d97706fc7585576d8a22eaa951ff7f193dec3 154562 pool/main/libi/libinput/libinput10_1.31.3-1ubuntu1_arm64.deb
fb6a546ca1a0356bf540f3a80538c5e3185971559a4a782ecede6e700237b8b2 208924 pool/main/libj/libjpeg-turbo/libjpeg8_3.1.3-4ubuntu2_arm64.deb
2dd355f4338c4f4e68c6c2fe5372fe452ae9de503ced4bcb31e2951a41042fec 903054 pool/main/j/jpeg-xl/libjxl0.11_0.11.2-5.1ubuntu1_arm64.deb
8a51e4617cbf71d14da66b88bfc1092cd540c82054a41b61e326aef8d02f8e5c 82088 pool/main/k/krb5/libk5crypto3_1.22.1-3ubuntu2_arm64.deb
e2bc53256588dfcd65460784f8cd432e41c8a8118e6232a5adafdf9fb2ffd3c0 45174 pool/universe/libk/libkate/libkate1_0.4.3-2_arm64.deb
0c0b4da672ca8e3e9ce972e3482a06f4cff5b4ebe774d2d04b2ad50d07bb566b 10772 pool/main/k/keyutils/libkeyutils1_1.6.3-6ubuntu3_arm64.deb
f254f287e8079728273f1b68ababc4e05348b497dfc184ab3d5439b71436f750 356858 pool/main/k/krb5/libkrb5-3_1.22.1-3ubuntu2_arm64.deb
35eef2826657331e3dc4286483ffdd46065e585dd471cd8894b3fabd40e8fad1 33848 pool/main/k/krb5/libkrb5support0_1.22.1-3ubuntu2_arm64.deb
2f2f6c7870ea31d6892d93c625f3775d3f9a89b97c21d506672999bd2f470103 171118 pool/main/l/lcms2/liblcms2-2_2.19.1-1_arm64.deb
b29cd918e50348b4fd6d5c2812990c4067702f8de8f4bf2b028e2636c6e7bdcb 190620 pool/main/o/openldap/libldap2_2.6.13+dfsg-1ubuntu3_arm64.deb
6e0f374fe15556c749968baa4815657527abd19df93386e17b737981af87a07b 30822194 pool/main/l/llvm-toolchain-22/libllvm22_22.1.8-1ubuntu1_arm64.deb
6a3e61844e91904ae2b5c3859fea12f8a8e1ae36aa5fdd7c003ab83cf5d7d397 157652 pool/universe/l/lua5.4/liblua5.4-0_5.4.9-1_arm64.deb
b6ae95d25ee9d31af9637dcc2b61ec4ea454cedceccb89b95c5837efe004238e 74954 pool/main/l/lz4/liblz4-1_1.10.0-10_arm64.deb
7344ae4ce20c58e12b31d0b48c37f270b4cd8d592485fe0a06bdbac42e0abcaf 144056 pool/main/x/xz-utils/liblzma5_5.8.3-1_arm64.deb
5db5f40c5f54843c165c1fced1b434a41268b7899028ead0d87978b1d2e52ab4 108568 pool/universe/libm/libmatroska/libmatroska7_1.7.2-1_arm64.deb
f7a4d10aa4536b4ecf0bac02e8a06194ab7857a357e1486d0cec6a5917a754bf 28592 pool/main/libm/libmd/libmd0_1.2.0-2_arm64.deb
9014d5b863ff939e984aaa05348f831cff010bf016511dd5c497b26e832fb91e 42704 pool/universe/m/md4c/libmd4c0_0.5.3-1_arm64.deb
c258daf03d959f122d281d5a6055bcd819508f6ece2141a95da88064fbce8f32 161560 pool/main/u/util-linux/libmount1_2.42.2-1ubuntu2_arm64.deb
c416cbe4b4b64c622ec07ae6bbdf1627065cc84356763a94126631531c34d1bd 119018 pool/main/l/lame/libmp3lame0_4.0-1_arm64.deb
23d18bad1aa0511914caa041062247f5ea464c2d45a619c7d94f9df0f2ca9a84 175268 pool/main/m/mpg123/libmpg123-0t64_1.33.7-1_arm64.deb
17f51e5b4294614286e28c962b9266464fa378f8760c5c8a8e978dbfa10bc71d 14904 pool/main/m/mtdev/libmtdev1t64_1.1.7-1build1_arm64.deb
62785cf0d484abd0ea786b0a35908c37a545b568005e78f1c46f1ee808ee90ff 167062 pool/main/libm/libmtp/libmtp9t64_1.1.23-1_arm64.deb
944c60f0400f576d1d44d8473a7d25d33a55f1a77d91c15e67c7bf35df650193 1157278 pool/universe/libm/libmysofa/libmysofa1_1.3.5+dfsg-1ubuntu1_arm64.deb
cbfbfc8da292e548ec5adb03031e753c94f14a2274f4a3eebc0f7298c396f350 147376 pool/main/n/ncurses/libncursesw6_6.6+20260608-2_arm64.deb
922ad03de441c26ca6e2a437545b7afdec5cfb6aeb123ee51b6b6a4e5b5a0975 189840 pool/main/n/nettle/libnettle8t64_3.10.2-1_arm64.deb
cf6c119f6406acdbcf3be667e0f90fed2f5db3a9c872fc1a170101191ee4c9a6 110940 pool/main/libn/libnfs/libnfs14_5.0.2-1ubuntu3_arm64.deb
cc7c91a24a390b6f211732c12552517b0283e9453e9bdad1d39db19d14761a66 70644 pool/main/n/nghttp2/libnghttp2-14_1.70.0-1_arm64.deb
485d1141fafe37de3e88d9d0931a9a205b53358a670456815ee853ed2b322aa9 152294 pool/universe/n/norm/libnorm1t64_1.5.9+dfsg-4_arm64.deb
166bdafa785118f4a1466540fe4abcbba055210c5c31057cdb53c6b76bffda3e 23774 pool/main/n/numactl/libnuma1_2.0.19-1build1_arm64.deb
53f0b4dfa389feb269bf46318b60b992f5c650d5febf82258638e89e88680ef5 23026 pool/main/libo/libogg/libogg0_1.3.6-2_arm64.deb
e4a8d06f52f2764adb3ef10037f2ae38e02fedcca9b98e06d897b0a94d84534c 34360 pool/main/libg/libglvnd/libopengl0_1.7.0-3_arm64.deb
ce3749a8f5e2ac7fa2dd2a0332b9801d7a400b2534a37ad71b395f5295bf4eef 178632 pool/main/o/openjpeg2/libopenjp2-7_2.5.4-1.1_arm64.deb
e879d997284b0c0d524bf944a9e631f377bcdad24c8080d7522122c7ed24dcfc 686254 pool/universe/libo/libopenmpt/libopenmpt0t64_0.8.7-1_arm64.deb
f87955a9649c7e76c575843047a2cbf309d29248de439d1cb84f95ebdd959eed 3537984 pool/main/o/opus/libopus0_1.6.1-1_arm64.deb
8c5623c49165656e0cc7f84b8446907fa2b2000b536db3f97bac2d7418a45620 306284 pool/main/p/p11-kit/libp11-kit0_0.26.5-1_arm64.deb
e183ff008fd1768187ffbf1955dec0cd87720a52b165c3c7c972a195a02375e5 235574 pool/main/p/pango1.0/libpango-1.0-0_1.58.0-1_arm64.deb
6feab826357dcd25b7fe78fb8e47211de0202348ea0818a64012b9dfd26b5199 31606 pool/main/p/pango1.0/libpangocairo-1.0-0_1.58.0-1_arm64.deb
675759649d7dec425013687fb900723f171e0113831de942db8ff81a87e2b1bf 51504 pool/main/p/pango1.0/libpangoft2-1.0-0_1.58.0-1_arm64.deb
b2a07b0d0043d7e701cd82f11e73d94c69003ca848b72d5399daf563c267c42d 219758 pool/main/p/pcre2/libpcre2-16-0_10.46-1build1_arm64.deb
f4219ccd273c6987cf3abcba8d2486e43cc771f89a9300fb7da8413015245660 236688 pool/main/p/pcre2/libpcre2-8-0_10.46-1build1_arm64.deb
4c51a0ba95e093b6fe5ec269178cd2f0ef7a1655f6cfd372be0eea6db8f24ca7 161262 pool/universe/libp/libpgm/libpgm-5.3-0t64_5.3.128~dfsg-3_arm64.deb
698cfdd737b50da27a926c262b7ce25370d4e95f182151b2b916ceb9a857c0bb 203872 pool/main/p/pixman/libpixman-1-0_0.46.4-1_arm64.deb
f508923b94dcc20bb72dfda40f12c3e85e781c3c83bf78b79d5cc2dbd649e7a8 187058 pool/main/libp/libpng1.6/libpng16-16t64_1.6.59-1_arm64.deb
a566371c4031e0b6544aeec9ca6c7df28892d69b629e95006c358c67fdc0283b 225414 pool/main/p/protobuf/libprotobuf-lite32t64_3.21.12-17_arm64.deb
1cf8026fb0752553f24d15618a04a0db6fc5a73397749b049f20c2749c454a24 25234 pool/main/libp/libproxy/libproxy1v5_0.5.12-3_arm64.deb
c23c4cd0de3c26734a74e085a7679887190d94c54ccbb320f55df0897433daa0 61148 pool/main/libp/libpsl/libpsl5t64_0.23.3-1_arm64.deb
d489cbddd21ba7819523922872e7669a3999f85127e08d45688c0ff22fcce80f 2042854 pool/universe/q/qt6-base/libqt6core6t64_6.11.2+dfsg-4ubuntu2_arm64.deb
6fe8051b3f27662c64b83d666416b9dc3dfcfc5c1b9e630ee541526eb395682a 278378 pool/universe/q/qt6-base/libqt6dbus6_6.11.2+dfsg-4ubuntu2_arm64.deb
9daa588c10df89cc652c4066068e94a9eb714441ac1ec2abc50413d264146f9d 3393598 pool/universe/q/qt6-base/libqt6gui6_6.11.2+dfsg-4ubuntu2_arm64.deb
414d5ba477c639f25603b562eef98ea870865d9b964024e511cc429a20e956cc 862802 pool/universe/q/qt6-base/libqt6network6_6.11.2+dfsg-4ubuntu2_arm64.deb
f022c929e79f38e27dba3a949e9f7ab437e09c86e720ef2a0ece79b54c34844d 460476 pool/universe/q/qt6-base/libqt6opengl6_6.11.2+dfsg-4ubuntu2_arm64.deb
2d0d5f568d23a5539f1a25defe8a4c54da2ca48d08bb28e6751e3a9f173acada 1857082 pool/universe/q/qt6-declarative/libqt6qml6_6.11.2+dfsg-2ubuntu1_arm64.deb
636f676bb7bc670359b5292352ed8ebdcbef5b7b115b9efa17470a343a9154c2 68958 pool/universe/q/qt6-declarative/libqt6qmlmeta6_6.11.2+dfsg-2ubuntu1_arm64.deb
b35ac0cc1f038b9773609565d50c0b2d07e73429a9f425d134436cdf0384d387 383864 pool/universe/q/qt6-declarative/libqt6qmlmodels6_6.11.2+dfsg-2ubuntu1_arm64.deb
3dbca8ef5d9f9dce710b8e90b1f5a359e99fd9d6e5a327ea23931cdb5a1b0579 38896 pool/universe/q/qt6-declarative/libqt6qmlworkerscript6_6.11.2+dfsg-2ubuntu1_arm64.deb
8de4e4ddd59210b6ae16dbddffd2101590de31b155a3aea45599e4655d6f0d96 2477602 pool/universe/q/qt6-declarative/libqt6quick6_6.11.2+dfsg-2ubuntu1_arm64.deb
1ff7a950f32367ea6db2332cd049afab7233d2243d4f060adc5bc995a9c650cd 858026 pool/universe/q/qt6-declarative/libqt6quickcontrols2-6_6.11.2+dfsg-2ubuntu1_arm64.deb
578c287892949a81667513c8a4974cdfda2e104de4b232e89f4961e3f545bdf9 145194 pool/universe/q/qt6-declarative/libqt6quickshapes6_6.11.2+dfsg-2ubuntu1_arm64.deb
979fc2e1c3337151bf43570b709f0cf36457ca1c582c8e9a6f53d5defe8e1caa 700834 pool/universe/q/qt6-declarative/libqt6quicktemplates2-6_6.11.2+dfsg-2ubuntu1_arm64.deb
be1c60c3173256cca8938805c5624405bbc183e2006cb14189a9f618ea912109 1599354 pool/universe/q/qt6-shadertools/libqt6shadertools6_6.11.2-1_arm64.deb
f1aca95e91adadbff56be93da319f9d01bfe988ff172f4d31a0c6924aae82f42 232124 pool/universe/q/qt6-svg/libqt6svg6_6.11.2-1_arm64.deb
e7d134bb609c2fddd9248ad7ee06bc39604a02736cfc880c961afcbc707b8e91 385478 pool/universe/q/qt6-base/libqt6waylandclient6_6.11.2+dfsg-4ubuntu2_arm64.deb
1b5c553d08aacfa17f5996f4175ce4a0b0422163cdb17f337971a30799de1c8d 2753800 pool/universe/q/qt6-base/libqt6widgets6_6.11.2+dfsg-4ubuntu2_arm64.deb
1b31228e722c7e6067e0f8643e469360a110e13bc9627d1558d4acbc7dd116ac 97806 pool/universe/q/qt6-base/libqt6wlshellintegration6_6.11.2+dfsg-4ubuntu2_arm64.deb
2baa2b350abb75b2a8a484c74e5be993cc410b79393956adfa9326a5dd0e6165 37360 pool/main/libr/librabbitmq/librabbitmq4_0.17.0-1build1_arm64.deb
f2eefd4a8548ee95f831b456299e5957bd1a08a964bdbc0b45bd3bcb94d241d3 800750 pool/universe/r/rust-rav1e/librav1e0.8_0.8.1-11_arm64.deb
ffd2e211b24fb508d904104d68f979dd4222c184375218721764334f1e2bfcff 25892 pool/universe/libr/libraw1394/libraw1394-11_2.1.2-2.1_arm64.deb
2a33f6cd8fa145ca0153812643f7c67dcea525c025eb3923c0d3a6c101eb2132 30394 pool/universe/s/sidplay-libs/libresid-builder0c2a_2.1.1-16build1_arm64.deb
66ee9c6e074a7d567b0cb42a0aa3967adc0d9add58b99d410e67412b6393c50d 108260 pool/universe/libr/librist/librist4_0.2.20+dfsg-1_arm64.deb
73f9b0c92cb4bb6ea578ec299b52d77d39f5177b63a3c5e8471007c8daac94e7 1760710 pool/main/libr/librsvg/librsvg2-2_2.62.1+dfsg-1ubuntu1_arm64.deb
17484c4dde6fbd56c05dd902fecfd2ecdb8182f0da07cee37d8fbec926bcdfe4 1340570 pool/main/libs/libsamplerate/libsamplerate0_0.2.2-4build2_arm64.deb
5f51ea5fa2d8c95a0369dcb45a6c76995a0d3c53d392b67345388c28d09b0525 53486 pool/main/c/cyrus-sasl2/libsasl2-2_2.1.28+dfsg1-11ubuntu2_arm64.deb
fa13bbeed49f7953e4006817b634195594be74c964b38c22509eb70ee0ba8fb6 51696 pool/main/libs/libseccomp/libseccomp2_2.6.1-1ubuntu1_arm64.deb
af65efbf62fa801b24c2416c877b588517f4e754d85652c96ea261abf736a4d4 116030 pool/main/libs/libsecret/libsecret-1-0_0.21.7-2build1_arm64.deb
c8fb70eda25a5a43903420b03fb3ab48e985b6ddb1d3c0ad2223e139beb9682a 93130 pool/main/libs/libselinux/libselinux1_3.11-2.1_arm64.deb
dc63821eccb23cf1784bad5287f9d6bed4e461c836372f5edd30fd5c609ff8af 29074 pool/main/l/lm-sensors/libsensors5_3.6.2-2build1_arm64.deb
439241d8e02c4741871951e08f22a625825f81b7db879754e2617ee1cb770b7a 16004 pool/main/libw/libwebp/libsharpyuv0_1.6.0-0.1_arm64.deb
c74a385d9ae7a04b49b80c81a0819fcdd331f4eb516ec0e0f780161816adce0a 25852 pool/universe/s/shine/libshine3_3.1.1-4_arm64.deb
2849a97a88f09ae5a5c8a410c864ec33d5f9bce9a228c4e1b5093037aef1ee44 49518 pool/main/libs/libshout/libshout3_2.4.6-1build4_arm64.deb
463be03b668044163c780c42ea1af4576f64bd45fca955ea45eb13c3323fac28 96266 pool/universe/s/sidplay-libs/libsidplay2_2.1.1-16build1_arm64.deb
ff3db9035a79798eb66bdc46547d7f07c88cb64fc701cea3d0133f88843e141a 16798 pool/main/libs/libsm/libsm6_1.2.6-1build1_arm64.deb
1e7cbea163e30dcf8fbeff6ca6b8077e4fc6d198167766e030e6cea589884399 30138 pool/main/s/snappy/libsnappy1v5_1.2.2-2_arm64.deb
0d3b66d3fd489a72af2647073fa93dd647ac15a0ef4bea6b9bd780f30f853056 162104 pool/main/libs/libsodium/libsodium26_1.0.22-2_arm64.deb
a119f6af4b68ec722981d18f1fcfbaec80b300881b73178e62c3fb019af91216 56084 pool/universe/libs/libsoxr/libsoxr0_0.1.3-4.1_arm64.deb
3340c2770467177e38de7fe34e39f4aaee885b14afdb60445830e34ab8ac22f1 1156748 pool/universe/libs/libspatialaudio/libspatialaudio2_0.4.1-1_arm64.deb
fbb4396f7d39f249407203e6e20755b0083d840f122c63832f03f6589f845a83 58276 pool/main/s/speex/libspeex1_1.2.1-3build1_arm64.deb
411c450ca3bf3bd6f5ee4e5eaffca634828a9b5ce5518a4e1f1e838a78d3c592 41418 pool/main/s/speexdsp/libspeexdsp1_1.2.1-4_arm64.deb
68a629d846ab69b0fcc9c8da89ac6d861a3d4fd663c0bf0f3c4c475ff1b39f26 329486 pool/universe/s/srt/libsrt1.5-gnutls_1.5.6-1build1_arm64.deb
1bc08bdc8616b880eb171fec2f4b63dc6ab0ea14e121c1cdfba6444445ac49bf 250702 pool/main/libs/libssh/libssh-4_0.12.2-1_arm64.deb
62809c9620360fc58ca21572112fccf90c3d86673c6862835ca30f2a02f6ac86 133136 pool/main/libs/libssh2/libssh2-1t64_1.11.1-6_arm64.deb
94d05d16dab461d132e26165172c756fd39745b28561521f43fa758359ea39e1 2785258 pool/main/o/openssl/libssl4_4.0.3-1ubuntu1_arm64.deb
339619908db6a3e0ac013cf663785fd7870ff68bdab93e728988db5004d3ef40 826870 pool/main/g/gcc-16/libstdc++6_16.2.0-3ubuntu1_arm64.deb
7b4a549fd23c8d2765b9caca9d00f1420049fc0970a3fcd29e4627060eaf4a67 1952506 pool/universe/s/svt-av1/libsvtav1enc4_4.1.0+dfsg-1_arm64.deb
5cbdf3289db389fdf4cb73f61de20fec82fa498ea730c188bd80fe0b23dea92d 67920 pool/universe/f/ffmpeg/libswresample6_8.1.2-2ubuntu2_arm64.deb
becce215ee0f0e9f3d020a91b1e89dd71efbe03780f0078adfc3b4e6fb195efd 3056936 pool/universe/f/ffmpeg/libswscale9_8.1.2-2ubuntu2_arm64.deb
4d18e7ec7434daa0a8373a260b567781e23171ee9aeb631c90f5283e479d849f 500710 pool/main/s/systemd/libsystemd0_261.3-0ubuntu3_arm64.deb
6c206e622aa665a42bcc25a0fdcc96b006e8b00bda2850bdc1375f11a5c40908 423636 pool/main/t/taglib/libtag2_2.3.2-3_arm64.deb
63d38a74ad15cc88fec21f408cdabf857d5c5a9d83887a21915c24b428fa6576 44426 pool/main/libt/libtasn1-6/libtasn1-6_4.21.0-2_arm64.deb
8733d04697cfe0626d5af2fa4384bdb84d31457670f8d0b6199b941a0aa5c8f6 17854 pool/main/libt/libthai/libthai0_0.1.30-3_arm64.deb
5fafa0964e3f3fa18659c09c48162b5533f316c10facf4ab6c90ce9c727e9572 144982 pool/main/libt/libtheora/libtheora1_1.2.0+dfsg-6_arm64.deb
d4d1b0c87db360e278fad6dfffe4a43b47e647e2b94d209224f323570012df5e 55880 pool/main/libt/libtheora/libtheoradec2_1.2.0+dfsg-6_arm64.deb
96496f67a6b1207e3b074382edeb129188ba3f5495086bfdf2593370727a0fec 111270 pool/main/libt/libtheora/libtheoraenc2_1.2.0+dfsg-6_arm64.deb
1a0f4c9b74d7f5e0f1f033118af311432d75165a232a8686a79b5303444a2cb5 104892 pool/main/n/ncurses/libtinfo6_6.6+20260608-2_arm64.deb
3d1d6496f56312a7d6376b6db39113b510aa882f3bda0150d58c8f2996a10ca0 64944 pool/universe/t/tslib/libts0t64_1.22-1.1build2_arm64.deb
6db808245660e9c5b46ce4e93f522affce830f0a3b790bce621647b3177a9bc8 51704 pool/main/t/twolame/libtwolame0_0.4.0-3_arm64.deb
0d875dad6d73a00b620cc78c138b13104a1853b0451ef8736242fff0335f927f 158686 pool/main/s/systemd/libudev1_261.3-0ubuntu3_arm64.deb
6504312506b72a6d27b9c411da83ba0f982b6a32d73ae60b7e972eff2dd208e9 16988 pool/universe/libu/libudfread/libudfread3_1.2.0-3_arm64.deb
d3a260e1668dd17171033bcf9f19726bffb5a01e8e999f77a773f4ec23a7e4dd 25698 pool/universe/libu/libunibreak/libunibreak7_7.0-2_arm64.deb
ee0949fb46a1bc07e516324ae34a8e7d08be4fea362972783d262f541335c7ef 604450 pool/main/libu/libunistring/libunistring5_1.4.2-1_arm64.deb
1d83d4f950dbfb26548b460e90f8bba76720213b4e07c66bc54667f863f1f804 26928 pool/main/libu/liburing/liburing2_2.15-1_arm64.deb
ce9eb9af7a72b62778cae2ab63d1faa87c7f8f91d1fdb95e735a325a286cc41c 55322 pool/main/libu/libusb-1.0/libusb-1.0-0_1.0.30-1_arm64.deb
0acc778b38bfb705c8bc18624e2d6eba8a19ba006e96ade55e276cfed29a8889 37194 pool/main/u/util-linux/libuuid1_2.42.2-1ubuntu2_arm64.deb
f774bc667e4a10a050e2d88ce9cc7612c57019a6cd25c0fda8216b12fc26785b 7158 pool/main/libv/libva/libva-drm2_2.24.1-2_arm64.deb
87f6737a9dd4ed0dbb14f72401278a78c01fe2e2db994851ae8f27616a395bd1 10898 pool/universe/libv/libva/libva-wayland2_2.24.1-2_arm64.deb
e9d6294308c66433dfc701ce9d8fa603ab8ede932898e2355f1f26b1a8f61013 12154 pool/universe/libv/libva/libva-x11-2_2.24.1-2_arm64.deb
876334a7861f75db8808dccbf965d80f7bb0255d1269d608d4f0fefbc2a99f39 76536 pool/main/libv/libva/libva2_2.24.1-2_arm64.deb
231a7a8c03290005c53c4d2d51f98103efac2a7ac76f0a7d61d2b5c74a93ae88 25840 pool/main/libv/libvdpau/libvdpau1_1.5-4_arm64.deb
d4adfb77a7ea7f68f73862ce2e7f2786d997f992508981bb2e37f81c539a878f 96562 pool/main/libv/libvorbis/libvorbis0a_1.3.7-3build2_arm64.deb
543fd0c07887df036cad5a913057dd0c58a60fd6de2709a721900bfce87dfa28 79494 pool/main/libv/libvorbis/libvorbisenc2_1.3.7-3build2_arm64.deb
0061bb6c17b345fc47928b87f4bcdc230e421610ac8ce72bb3f6cbf8231acb5a 16952 pool/main/libv/libvorbis/libvorbisfile3_1.3.7-3build2_arm64.deb
6f988feb9d4136baf981b90c759e5f478172693f4e487fd8dddcb2bd0773bd69 1334956 pool/main/libv/libvpx/libvpx12_1.16.0-3_arm64.deb
12409a81bae015a1d39e0779ab88801aa8582a45ca442ca093b79f1e2d1f0b49 28454 pool/main/libw/libwacom/libwacom9_2.18.0-1_arm64.deb
f3efe7937ad9b678bc61279e7be74a4881a779750c275e8a2f174f6026be9c79 28430 pool/main/w/wayland/libwayland-client0_1.26.0-1_arm64.deb
f4a37c98a9e185630e486e59152caa621cfa5937be0fefed996bd81e5fd24f05 10750 pool/main/w/wayland/libwayland-cursor0_1.26.0-1_arm64.deb
bdf9650abfcc7e31f872f28a859d8613c62d79e19db141b5e3d6ed2d7324d52c 6050 pool/main/w/wayland/libwayland-egl1_1.26.0-1_arm64.deb
4d1353a7913855e5d372d428f9212cdb5fa99f3a3892b850a5787faf86bad188 203926 pool/main/libw/libwebp/libwebp7_1.6.0-0.1_arm64.deb
945ce223d1feee2b3a8ecb8a922c1cba00351698379cfd358b8d97eaeea1788e 25440 pool/main/libw/libwebp/libwebpmux3_1.6.0-0.1_arm64.deb
955ede3dfadc55c6257f5d8d2d7ed2f60891afc79c310c76f238bc2f1c83f7de 652114 pool/main/libx/libx11/libx11-6_1.8.13-1_arm64.deb
8188c233d59dc419205c314ef8f230fc83ca7a3e7e9b9671f18b469fd3e428ae 114288 pool/main/libx/libx11/libx11-data_1.8.13-1_all.deb
89a98329e5251691050be79fccb10a4bee31cd538c310300795893cb9a46a2c8 8126 pool/main/libx/libx11/libx11-xcb1_1.8.13-1_arm64.deb
aa93a5a9b477ce24601f30cd2a0694da43b947722fadc345b5f6961fcaff6cd6 539496 pool/universe/x/x264/libx264-165_0.165.3223+git20250910.0480cb0-1_arm64.deb
1dda862507c656740c28e8d6c18ba57cf860b08c6594ab901e761002bb5929d2 2405088 pool/universe/x/x265/libx265-216_4.2-3_arm64.deb
2df4a14fea0c98f2e52c8ad3e2cfed6f5d40b66e5aa15af01eba24edfe2686ae 7644 pool/main/libx/libxau/libxau6_1.0.11-1build2_arm64.deb
ff261935d3c6941a8a84d43d31073626fb8768d9abb30978587fa116f8ca8fed 10598 pool/universe/x/xcb-util-cursor/libxcb-cursor0_0.1.6-1_arm64.deb
a3f538fb0f99824a36ce248d91d87bba985006cc19554c44eee214482c588368 7624 pool/main/libx/libxcb/libxcb-dri3-0_1.17.0-2ubuntu1_arm64.deb
d9dea4d64d7b5c33cabdaf0cccc67c4eed1a6f400e8ea2e71d0d581f9672b0c8 25128 pool/main/libx/libxcb/libxcb-glx0_1.17.0-2ubuntu1_arm64.deb
87751190cc0c61c151937d4f17ea74da6a8b40d3571e92d9a463d0f9dfabed9a 10924 pool/universe/x/xcb-util-wm/libxcb-icccm4_0.4.2-1build1_arm64.deb
e7c00280d66ec69c4b0516a295ca14c7b2000f8068b67e2532b777c90b508f09 10806 pool/universe/x/xcb-util-image/libxcb-image0_0.4.0-2build2_arm64.deb
72282e112ef179672b38c777f40bb8d4145512f1382be76ee05307bc752bd2ed 8790 pool/universe/x/xcb-util-keysyms/libxcb-keysyms1_0.4.1-1build1_arm64.deb
511b6c9afab2790d10f808c1bd1a24c81cedeb6600ed1ad517a17c8e9a5ef23b 6198 pool/main/libx/libxcb/libxcb-present0_1.17.0-2ubuntu1_arm64.deb
64bce047a66f7f8ce5a64f93fd43c946e74c2cf679ee142e9502891ad362963f 18060 pool/main/libx/libxcb/libxcb-randr0_1.17.0-2ubuntu1_arm64.deb
dcf55b5eeb0c44bbc2b09c466e145f9eb208059af6e1ef340c4090e018865fed 10412 pool/universe/x/xcb-util-renderutil/libxcb-render-util0_0.3.10-1build1_arm64.deb
2a623dd24bc7cf5e80f2fc8ee537dab02b70dbb72a68903676a99a629cd40356 16412 pool/main/libx/libxcb/libxcb-render0_1.17.0-2ubuntu1_arm64.deb
7fabfb1ef40ab742b432dfb2e2244ab292364ef098e8607259b95ad150256e5b 6360 pool/main/libx/libxcb/libxcb-shape0_1.17.0-2ubuntu1_arm64.deb
dbcf77b20a17a95fbe3ca52c5cd607a682ada8f70eb7c36dbcf1d8b2aab84533 5938 pool/main/libx/libxcb/libxcb-shm0_1.17.0-2ubuntu1_arm64.deb
4904208813f265e5cc452d0eac62501d3b42a9d0c326d447d8e81bacd0604c78 9620 pool/main/libx/libxcb/libxcb-sync1_1.17.0-2ubuntu1_arm64.deb
9b2b2a5970eb3870488e150caa6d6da50752ec832986b670bb9af477552b28ef 10652 pool/main/x/xcb-util/libxcb-util1_0.4.1-1build1_arm64.deb
619b45cdb525ed16a9ff466dd11497d1361482dbefa31da2029cb209fd8dbab2 10430 pool/main/libx/libxcb/libxcb-xfixes0_1.17.0-2ubuntu1_arm64.deb
5b75a138be89419f953db6ebf6dab6aeba85cdd41ee8f56b3eb8a892b04ccca1 33270 pool/main/libx/libxcb/libxcb-xinput0_1.17.0-2ubuntu1_arm64.deb
62a2646163addecfffdc76125603bdce6096cf2739631e3737ecbd5759bdef32 32200 pool/main/libx/libxcb/libxcb-xkb1_1.17.0-2ubuntu1_arm64.deb
59fa782e45c93a024851df6fb92d5a0d5c84416898b9640c35ece50d1f2fdfda 49190 pool/main/libx/libxcb/libxcb1_1.17.0-2ubuntu1_arm64.deb
e90265c37e823b293a4c0db30a906772d6f675d15a73c747c7431b5a5b0db8e6 10856 pool/main/libx/libxdmcp/libxdmcp6_1.1.5-2_arm64.deb
ca31152c03800241e64bb8623a642493bfc76bcfa151398931e92f277dc85fb7 30222 pool/main/libx/libxext/libxext6_1.3.4-1build3_arm64.deb
04c2b8fb6d291f09b61a8ff0f1272af986989a53272706593c96f52604c20383 11368 pool/main/libx/libxfixes/libxfixes3_6.0.0-2build2_arm64.deb
8e248cb094bb3508e5c68ab5e89572cd82ea3fe2639b49f2b7d9dbefd4fa31ef 13990 pool/main/libx/libxkbcommon/libxkbcommon-x11-0_1.13.1-1_arm64.deb
5e38f3f1edc2518779a1f687e92c105d8a75a80a3d72907b164565b9b951d264 156102 pool/main/libx/libxkbcommon/libxkbcommon0_1.13.1-1_arm64.deb
48677474dd75af9917aac636c21a26f02f3748ad066f70d8f34eebe1ff65ccea 607592 pool/main/libx/libxml2/libxml2-16_2.15.4+dfsg-1_arm64.deb
68d8632814a9152392467aec92d93ea1c37ef254592fb263bee7c4fe946393b7 19312 pool/main/libx/libxrender/libxrender1_0.9.12-1build1_arm64.deb
4b288951c1ce9fa001640ee8f080505fa88f4b82039719199109c82082c9c7dd 5482 pool/main/libx/libxshmfence/libxshmfence1_1.3.3-1build1_arm64.deb
1b3c5e5fbe6d657cc41116fec5a31bcf0c7db7b6e1c346c7082f8740eb7ccfed 171150 pool/universe/x/xvidcore/libxvidcore4_1.3.7-3_arm64.deb
e76a55383d516ee68fed55ec15f94cf375a6f0f1ca349958ce0f02d72d507112 10228 pool/main/libx/libxxf86vm/libxxf86vm1_1.1.4-2_arm64.deb
f42050b57b43fdccb5ce91684cf7dafd01a2d9e38119c2643c718b3fb3607efd 21674 pool/main/x/xxhash/libxxhash0_0.8.3-2build1_arm64.deb
15e9f2e2322c03d25e051ae6e0ba03f372b060c5a2e1c289f13f90a1524f0428 243186 pool/universe/z/zeromq3/libzmq5_4.3.5-1build4_arm64.deb
4a3c2990406d5f1b5aed648c3674b06e0958ba20adfe8fcfae293b3c998ba876 275684 pool/main/libz/libzstd/libzstd1_1.5.7+dfsg-4_arm64.deb
c87186571e0fa52a12b9623b24f870027d3b2cca14e0b45b5c923f8c59ca479a 258224 pool/universe/z/zvbi/libzvbi0t64_0.2.45-1_arm64.deb
932129c4c5834d2db4ecfc9866a3f9effb2615db56628557478a970cf7d021b7 12763014 pool/main/m/mesa/mesa-libgallium_26.2.4-1ubuntu1_arm64.deb
f5743c6370b2cb91bddd9c3d835ddc93e096d4c65b4be6e5cb7b14a2c045d306 41052 pool/main/o/ocl-icd/ocl-icd-libopencl1_2.3.4-1_arm64.deb
7e1c7e6ecedf0338f58689f62aac13e3a895e1a91e813b98ddad70cfe7e77e51 362440 pool/universe/q/qt6-5compat/qml6-module-qt5compat-graphicaleffects_6.11.2-1_arm64.deb
9f516f75ffa35cf739e1ee53b88fe9fcb5daf9193784be19edba8d4e75804dc5 14510 pool/universe/q/qt6-declarative/qml6-module-qtqml_6.11.2+dfsg-2ubuntu1_arm64.deb
d325b82c87287f3e7a4bed8d94a5bb031df4ce173086cb14581fb15432a92c04 19300 pool/universe/q/qt6-declarative/qml6-module-qtqml-models_6.11.2+dfsg-2ubuntu1_arm64.deb
93582be950571bccbbf33cbdf1a8cb64577ba65a08456a90ce68ce4daf549be2 13692 pool/universe/q/qt6-declarative/qml6-module-qtqml-workerscript_6.11.2+dfsg-2ubuntu1_arm64.deb
bfd1f7944d46dbda916e0107d7baa12fd709495a0615c757d21447547015c22f 63802 pool/universe/q/qt6-declarative/qml6-module-qtquick_6.11.2+dfsg-2ubuntu1_arm64.deb
50cf1fecb17f7c79718fb8b28c3f13f54fd104d98c95a5d7e4d7af4f82fe4f1b 109598 pool/universe/q/qt6-declarative/qml6-module-qtquick-controls_6.11.2+dfsg-2ubuntu1_arm64.deb
98022bf26747b5a412968de4ad96bb56000854dda33e3d8b2ddd57653cefce61 121700 pool/universe/q/qt6-declarative/qml6-module-qtquick-layouts_6.11.2+dfsg-2ubuntu1_arm64.deb
b940ae3a24d856539699cc967af6ba1f5db61700577911c1a3c170a971d28cc4 15838 pool/universe/q/qt6-declarative/qml6-module-qtquick-shapes_6.11.2+dfsg-2ubuntu1_arm64.deb
52da985ed97bc8d5da9ce1bb80ab69169497eaa02b028a4b93e2c68599292d44 32716 pool/universe/q/qt6-declarative/qml6-module-qtquick-templates_6.11.2+dfsg-2ubuntu1_arm64.deb
c3a045a12044131cf7c9d7b10dc5885640c747ac7979fe728c0339bdf2013911 13794 pool/universe/q/qt6-declarative/qml6-module-qtquick-window_6.11.2+dfsg-2ubuntu1_arm64.deb
df105bdf4359978a36c1606e3406058e5a867a90cdf1829447eaa7c3e5c166ff 31324 pool/universe/q/qt6-svg/qt6-svg-plugins_6.11.2-1_arm64.deb
6a73499c1d854fcbf2687295f78710f6b71a8020e2431ed29f079da74d618d6e 104902 pool/universe/q/qt6-wayland/qt6-wayland_6.11.2-1_arm64.deb
78e6bd33378fff7e749c9443f5e16feb440048a8cc741b19a87173eb8c7d1a8b 394062 pool/main/x/xkeyboard-config/xkb-data_2.48-1_all.deb
09a3263ccf28dff77d6ca0f8525f93a00dd4a9e3f0503b4be8fd9e1fa2d71daf 64380 pool/main/z/zlib/zlib1g_1.3.dfsg+really1.3.2-3ubuntu1_arm64.deb
`;
