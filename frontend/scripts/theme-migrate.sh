#!/usr/bin/env bash
# theme-migrate.sh — переводит legacy экран с хардкода цветов на useThemeContext().
# Использование: bash theme-migrate.sh <file>
# Идемпотентен: повторный запуск не ломает уже мигрированный файл.
set -euo pipefail
F="$1"

[[ -f "$F" ]] || { echo "no file: $F"; exit 1; }

# 1. Импорт useThemeContext, если ещё нет.
if ! grep -q "useThemeContext" "$F"; then
  # Вставляем импорт ПОСЛЕ последнего import-а из react-native context-файлов.
  # Делаем универсально: после первого импорта react-router/expo-router/SafeAreaView/Ionicons.
  python3 - "$F" <<'PY'
import re, sys, os
fp = sys.argv[1]
src = open(fp, 'r', encoding='utf-8').read()
# Find end of import block: position after the last `} from '...';` or `import xxx from '...';`
# Universal regex: matches single-line OR multi-line import statements consecutively.
m = re.match(
    r"((?:(?:^import [^;\n]*?;\s*\n)|(?:^import \{[^}]*\}[^;]*?;\s*\n))+)",
    src,
    re.MULTILINE | re.DOTALL,
)
if not m:
    sys.exit(0)
import os as _os
rel = _os.path.relpath('/app/frontend/src/context/ThemeContext', _os.path.dirname(fp))
inject = f"import {{ useThemeContext }} from '{rel}';\n"
new_src = m.group(0) + inject + src[m.end():]
open(fp, 'w', encoding='utf-8').write(new_src)
PY
fi

# 2. Оборачиваем StyleSheet.create в makeStyles(colors) — если не обёрнуто.
if ! grep -q "const makeStyles = (colors" "$F"; then
  python3 - "$F" <<'PY'
import re, sys
fp = sys.argv[1]
src = open(fp, 'r', encoding='utf-8').read()
src2 = re.sub(
    r"const styles = StyleSheet\.create\(\{",
    "const makeStyles = (colors: any) => StyleSheet.create({",
    src, count=1)
# Закрывающий `});` оставляем — он же закрывает arrow-fn body.
open(fp, 'w', encoding='utf-8').write(src2)
PY
fi

# 3. Внутри компонента: вставить `const { colors } = useThemeContext(); const styles = makeStyles(colors);`
#    после первой строки `export default function ... () {`.
if ! grep -q "const styles = makeStyles(colors)" "$F"; then
  python3 - "$F" <<'PY'
import re, sys
fp = sys.argv[1]
src = open(fp, 'r', encoding='utf-8').read()
def inject(m):
    head = m.group(0)
    add = "\n  const { colors } = useThemeContext();\n  const styles = makeStyles(colors);"
    return head + add
src2 = re.sub(
    r"export default function [A-Za-z0-9_]+\([^)]*\) \{",
    inject, src, count=1)
open(fp, 'w', encoding='utf-8').write(src2)
PY
fi

# 4. Безопасные замены hardcoded backgrounds + borders → colors.X
python3 - "$F" <<'PY'
import re, sys
fp = sys.argv[1]
src = open(fp, 'r', encoding='utf-8').read()

# Замены — только в style-context (после двоеточия, в кавычках):
pairs = [
    # backgrounds
    (r"backgroundColor:\s*'#0[aA]0[aA]0[aA]'",        "backgroundColor: colors.background"),
    (r"backgroundColor:\s*'#0F1419'",                  "backgroundColor: colors.backgroundSecondary"),
    (r"backgroundColor:\s*'#1[aA]1[aA]1[aA]'",         "backgroundColor: colors.card"),
    (r"backgroundColor:\s*'#1A222D'",                  "backgroundColor: colors.card"),
    (r"backgroundColor:\s*'#161D26'",                  "backgroundColor: colors.backgroundTertiary"),
    (r"backgroundColor:\s*'#3B82F6'",                  "backgroundColor: colors.primary"),
    (r"backgroundColor:\s*'rgba\(255,\s*255,\s*255,\s*0\.05\)'",
                                                       "backgroundColor: colors.backgroundTertiary"),
    (r"backgroundColor:\s*'rgba\(255,\s*255,\s*255,\s*0\.1\)'",
                                                       "backgroundColor: colors.border"),
    (r"backgroundColor:\s*'rgba\(255,\s*255,\s*255,\s*0\.08\)'",
                                                       "backgroundColor: colors.border"),
    # borders
    (r"borderColor:\s*'rgba\(255,\s*255,\s*255,\s*0\.05\)'",
                                                       "borderColor: colors.divider"),
    (r"borderColor:\s*'rgba\(255,\s*255,\s*255,\s*0\.1\)'",
                                                       "borderColor: colors.border"),
    (r"borderBottomColor:\s*'rgba\(255,\s*255,\s*255,\s*0\.1\)'",
                                                       "borderBottomColor: colors.border"),
    (r"borderTopColor:\s*'rgba\(255,\s*255,\s*255,\s*0\.1\)'",
                                                       "borderTopColor: colors.border"),
    # text colors (на light будут невидимы как white-on-white)
    (r"color:\s*'#FFFFFF'",                            "color: colors.text"),
    (r"color:\s*'#fff'",                               "color: colors.text"),
    (r"color:\s*'#9CA3AF'",                            "color: colors.textMuted"),
    (r"color:\s*'#6B7280'",                            "color: colors.textMuted"),
    (r"color:\s*'#94A3B8'",                            "color: colors.textMuted"),
    (r"color:\s*'#64748B'",                            "color: colors.textMuted"),
    (r"color:\s*'#4B5563'",                            "color: colors.textSecondary"),
]
for pat, rep in pairs:
    src = re.sub(pat, rep, src)
open(fp, 'w', encoding='utf-8').write(src)
PY

echo "✓ migrated: $F"
