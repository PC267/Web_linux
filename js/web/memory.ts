// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// How much memory to give the kernel in a browser.

/**
 * Sizes createKernel() tries, in order, when the requested memory cannot be
 * allocated (phones often lack the address space for the larger ones).
 */
export const DEFAULT_MEMORY_FALLBACK_MIB: readonly number[] = Object.freeze([1024, 512, 384, 256, 192, 128, 96, 64]);

/** A phone or tablet: a coarse pointer (touch) or a mobile user agent (the old page's rule). */
export function isMobile(): boolean {
	const nav = globalThis.navigator as Navigator | undefined;
	if (!nav) return false;
	const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
	return coarse || /Android|iPhone|iPad|Mobi/i.test(nav.userAgent ?? "");
}

/**
 * A memory size for this device: from navigator.deviceMemory (secure
 * contexts only) when known, else 512 MiB on phones and 2 GiB otherwise
 * (at most 512 MiB on a phone whatever it reports). Memory the guest never
 * touches costs the host nothing.
 */
export function autoMemoryMiB(opts: { mobile?: boolean } = {}): { mib: number; why: string } {
	const devMem = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory;
	const mobile = opts.mobile ?? isMobile();
	if (devMem) return { mib: devMem <= 1 ? 96 : devMem <= 2 ? 256 : devMem <= 4 || mobile ? 512 : 2048, why: `auto: device reports ${devMem} GB` };
	if (mobile) return { mib: 512, why: "auto: mobile device" };
	return { mib: 4096, why: "auto" };
}
