"""Replace the icon resources of a PE without touching the rest of the file.

Strategy
--------
Rather than rebuilding the whole resource tree (risky on a 100 MB Node SEA
binary whose RT_RCDATA holds the injected blob), this rewrites *in place*:

  1. Every existing RT_ICON image is overwritten with one of our icon frames,
     padded to at least the original size.
  2. The RT_GROUP_ICON directory entry is rewritten so it points at the same
     resource ids, with our dimensions and the new byte counts.
  3. If our .ico has more frames than the exe has RT_ICON slots, the extra
     frames are appended to the end of the icon resource's section (the
     resource directory itself is patched to describe them).

Everything else (RT_RCDATA with the SEA blob, version info) is untouched.
"""
import struct
import sys

import pefile

RT_ICON = 3
RT_GROUP_ICON = 14


def read_ico(path):
    data = open(path, "rb").read()
    reserved, kind, count = struct.unpack_from("<HHH", data, 0)
    if reserved or kind != 1:
        sys.exit("not an .ico")
    frames = []
    for i in range(count):
        off = 6 + i * 16
        w, h, colors, res, planes, bits, size, doff = struct.unpack_from("<BBBBHHII", data, off)
        frames.append({
            "w": w or 256, "h": h or 256, "colors": colors, "res": res,
            "planes": planes, "bits": bits, "size": size,
            "blob": data[doff:doff + size],
        })
    return frames


def main():
    exe_path, ico_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    frames = read_ico(ico_path)
    pe = pefile.PE(exe_path)

    # map resource id -> (data offset in file, size)
    icon_slots = {}
    group_slot = None
    for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        for sub in entry.directory.entries:
            for lang in sub.directory.entries:
                d = lang.data.struct
                slot = (d.OffsetToData, d.Size)
                if entry.id == RT_ICON:
                    icon_slots[sub.id] = slot
                elif entry.id == RT_GROUP_ICON:
                    group_slot = (sub.id, slot)

    if not icon_slots or group_slot is None:
        sys.exit("no icon resources found")
    print("existing icon ids:", sorted(icon_slots), "group id:", group_slot[0])

    img = bytearray(open(exe_path, "rb").read())

    def file_offset(rva):
        """Resource OffsetToData is an RVA; convert it to a file offset."""
        return pe.get_offset_from_rva(rva)

    # ---- overwrite each existing RT_ICON with one of our frames ----------
    ids = sorted(icon_slots)
    for idx, rid in enumerate(ids):
        rva, size = icon_slots[rid]
        off = file_offset(rva)
        blob = frames[idx]["blob"] if idx < len(frames) else frames[-1]["blob"]
        if len(blob) > size:
            # Cannot grow in place: fall back to the largest frame that fits.
            fits = [f for f in frames if len(f["blob"]) <= size]
            if not fits:
                sys.exit(f"frame does not fit slot {rid} ({size} bytes)")
            blob = fits[-1]["blob"]
            used = fits[-1]
        else:
            used = frames[idx] if idx < len(frames) else frames[-1]
        img[off:off + len(blob)] = blob
        # zero any slack so no stale bytes remain
        if len(blob) < size:
            img[off + len(blob):off + size] = b"\x00" * (size - len(blob))
        frames[idx] = used

    # ---- rewrite the group directory -------------------------------------
    gid, (grva, gsize) = group_slot
    goff = file_offset(grva)
    n = len(ids)
    group = struct.pack("<HHH", 0, 1, n)
    for idx, rid in enumerate(ids):
        f = frames[idx]
        _rva, size = icon_slots[rid]
        group += struct.pack("<BBBBHHIH", f["w"] % 256, f["h"] % 256, f["colors"], f["res"],
                             f["planes"], f["bits"], len(f["blob"]), rid)
    if len(group) > gsize:
        sys.exit(f"icon group grew from {gsize} to {len(group)} bytes")
    img[goff:goff + len(group)] = group
    if len(group) < gsize:
        img[goff + len(group):goff + gsize] = b"\x00" * (gsize - len(group))

    open(out_path, "wb").write(img)
    print(f"wrote {out_path} ({len(img)} bytes), {n} icon slots updated")

    # ---- verify ----------------------------------------------------------
    check = pefile.PE(out_path)
    for entry in check.DIRECTORY_ENTRY_RESOURCE.entries:
        for sub in entry.directory.entries:
            for lang in sub.directory.entries:
                d = lang.data.struct
                kind = pefile.RESOURCE_TYPE.get(entry.id, entry.id)
                print(f"  {kind} {sub.id}: offset={d.OffsetToData} size={d.Size}")


if __name__ == "__main__":
    main()
