// A leaf: every installer (skill.ts, capture-kit.ts, setup.ts) imports it, and it imports nothing.

/**
 * `put <file> <label> <<EOF`: writes stdin to the file only when it differs,
 * and says which, so a re-run of any installer reports that nothing changed.
 * `cat >` rather than `mv`, so an existing file keeps its mode.
 */
export const PUT_FN = `put() {
  _t=$(mktemp)
  cat > "$_t"
  if [ -f "$1" ] && cmp -s "$_t" "$1"; then echo "  unchanged $2"; else cat "$_t" > "$1"; echo "  wrote $2"; fi
  rm -f "$_t"
}`;
