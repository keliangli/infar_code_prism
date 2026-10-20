#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
extract_graph.py
================

Static AST extractor that turns a Python package tree (the SGLang ``sglang/srt``
source root) into a deterministic JSON dependency graph, meant to be rendered by
a Three.js "3D code map" frontend.

Design notes
------------
* Standard library only (``ast``, ``pathlib``, ``json``, ``argparse`` ...).
  The parsed source is **never executed**, only statically analysed.
* Deterministic output: every list is sorted with an explicit, stable rule.
  The only non-deterministic field is ``meta.generatedAt`` and it can be
  disabled with ``--no-timestamp``.

Counting rules (approximate by intent, kept simple & reproducible)
-----------------------------------------------------------------
* ``loc``          : ``len(text.splitlines())`` -> total physical lines.
* ``codeLines``    : a line counts when, after ``str.strip()``, it is neither
                     empty nor starts with ``#``.  (No docstring/block-comment
                     awareness -- "approximate" as agreed with the frontend.)
* ``defs``         : every ``FunctionDef`` / ``AsyncFunctionDef`` node found by
                     ``ast.walk`` (i.e. methods and nested functions included).
* ``classes``      : every ``ClassDef`` node found by ``ast.walk``.
* ``symbols``      : file-internal structure for the "drill-down" view: top-level
                     classes / functions plus one-level methods (see
                     :func:`collect_symbols`).  ``symbolTotal``/``symbolEdgeTotal``
                     aggregate symbol counts and intra-file call edges.
* ``fanOut`` (file): number of *distinct* internal target files imported.
* ``fanIn``  (file): number of *distinct* internal source files importing it.
* ``weight``       : how many times the same ``from -> to`` pair occurs
                     (repeated imports accumulate).
* District ``fanIn``/``fanOut``: counted over *cross-district* file-level edges,
                     i.e. ``packageEdges`` weights aggregated per district.

Module resolution
-----------------
Absolute imports starting with ``sglang.srt.`` are mapped onto the input root by
stripping that prefix; relative imports (``level > 0``) are resolved against the
importing file's package directory.  A target resolves only when it exists inside
the root as ``<pkg>.py`` or ``<pkg>/__init__.py``; anything else (third-party,
dynamic, ``try/except`` fallbacks, ``sglang``-only prefixes) is ignored and just
counted as ``meta.unresolvedImports``.
* ``from pkg import name``: when ``pkg`` is a package, each ``name`` is first
  tried as a submodule (``pkg/name.py``); resolved names edge to the submodule
  instead of the package ``__init__``.  When no name resolves, the statement
  keeps its package/module edge (the names are then symbols defined there).
* Files that fail to parse (``SyntaxError``) are counted in ``meta.parseErrors``
  instead of silently contributing zero metrics.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys
import warnings
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Default prefix that absolute imports use to reach the analysed root.
# Override with --prefix to point the extractor at another package tree.
DEFAULT_PREFIX = "sglang.srt"

# Default source root: env var first (portable), this machine checkout as fallback.
DEFAULT_ROOT = os.environ.get(
    "SGLANG_SRT_ROOT", r"D:\code\sglang\sglang-main\python\sglang\srt"
)

# Extraction output always lives inside the repo by default.
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "data" / "sglang-graph.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def iter_python_files(root: Path):
    """Yield every ``*.py`` file below *root*, skipping ``__pycache__``."""
    for path in sorted(root.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        yield path


def count_code_lines(text: str) -> int:
    """Non-empty, non-pure-comment line count (see module docstring rule)."""
    n = 0
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        n += 1
    return n


def _called_name(call: ast.Call):
    """Best-effort bare name of the callee of *call* (``None`` if not nameable)."""
    func = call.func
    if isinstance(func, ast.Name):
        return func.id            # foo(...)
    if isinstance(func, ast.Attribute):
        return func.attr          # self.foo(...) / mod.foo(...)
    return None


def collect_symbols(rel: str, tree: ast.AST) -> list:
    """Per-file symbols (classes / top-level functions / one-level methods).

    * ``start``/``end``/``loc`` are physical 1-based lines; a class's ``loc``
      spans the whole class body while a method only covers itself.
    * Functions nested *inside* functions are intentionally ignored (noise).
    * ``calls`` are the callee names found by walking ``ast.Call`` nodes in the
      symbol body, kept only when the name matches the file-local symbol *name*
      set (class + function + method names), deduped and sorted.
      Matching is by **bare name only**: two same-named methods sitting on
      different classes (or a function and a method sharing a name) are
      indistinguishable here.  This is a deliberate static approximation
      agreed with the frontend.
    * Symbols are ordered by ``start`` then ``name``; ids are ``<file>#<name>``
      with a ``#2``/``#3``/... suffix appended on name collisions so ids stay
      unique and deterministic.
    """
    local_names = set()
    raw = []  # dicts: name, kind, start, end, body(list of stmts)

    def end_line(node):
        return getattr(node, "end_lineno", None) or node.lineno

    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            local_names.add(node.name)
            methods = [
                sub
                for sub in node.body
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            for sub in methods:
                local_names.add(sub.name)
            raw.append(
                {
                    "name": node.name,
                    "kind": "class",
                    "start": node.lineno,
                    "end": end_line(node),
                    "body": node.body,
                }
            )
            for sub in methods:
                raw.append(
                    {
                        "name": sub.name,
                        "kind": "method",
                        "start": sub.lineno,
                        "end": end_line(sub),
                        "body": sub.body,
                    }
                )
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            local_names.add(node.name)
            raw.append(
                {
                    "name": node.name,
                    "kind": "function",
                    "start": node.lineno,
                    "end": end_line(node),
                    "body": node.body,
                }
            )

    for sym in raw:
        names = set()
        for stmt in sym["body"]:
            for n in ast.walk(stmt):
                if isinstance(n, ast.Call):
                    nm = _called_name(n)
                    if nm and nm in local_names:
                        names.add(nm)
        sym["calls"] = sorted(names)
        del sym["body"]

    raw.sort(key=lambda s: (s["start"], s["name"]))

    counts = defaultdict(int)
    symbols = []
    for sym in raw:
        counts[sym["name"]] += 1
        n = counts[sym["name"]]
        suffix = "" if n == 1 else f"#{n}"
        symbols.append(
            {
                "id": f"{rel}#{sym['name']}{suffix}",
                "name": sym["name"],
                "kind": sym["kind"],
                "start": sym["start"],
                "end": sym["end"],
                "loc": sym["end"] - sym["start"] + 1,
                "calls": sym["calls"],
            }
        )
    return symbols


# ---------------------------------------------------------------------------
# Core extraction
# ---------------------------------------------------------------------------


def extract(root: Path, root_label: str, prefix: str, with_timestamp: bool) -> dict:
    py_files = list(iter_python_files(root))

    # --- pass 1: collect file ids, metrics and file existence set -----------
    file_ids = set()          # relative POSIX ids of every .py inside the root
    metrics = {}              # id -> dict(loc, codeLines, defs, classes, sub, district)

    for path in py_files:
        rel = path.relative_to(root).as_posix()
        file_ids.add(rel)

    def resolve_parts(parts) -> str | None:
        """Map a list of module path parts to an internal file id, or None."""
        if not parts:
            return None
        rel = "/".join(parts)
        if rel + ".py" in file_ids:
            return rel + ".py"
        if rel + "/__init__.py" in file_ids:
            return rel + "/__init__.py"
        return None

    # --- pass 2: parse AST, collect metrics + raw edges ---------------------
    raw_edges = []            # list of (from_id, to_id) with multiplicity
    file_symbols = {}         # id -> [symbol dict]  (sorted by start, name)
    unresolved = 0
    parse_errors = 0
    code_lines_total = 0
    loc_total = 0
    def_total = 0
    class_total = 0
    symbol_total = 0
    symbol_edge_total = 0

    for path in py_files:
        rel = path.relative_to(root).as_posix()
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        loc = len(text.splitlines())
        code_lines = count_code_lines(text)

        # district = first path segment (or "root" when directly under root)
        parts = rel.split("/")
        if len(parts) == 1:
            district = "root"
            sub = None
        else:
            district = parts[0]
            sub = parts[1] if len(parts) > 2 else None

        defs = 0
        classes = 0
        try:
            # Parsed source may emit SyntaxWarning (e.g. invalid escape
            # sequences); those are upstream code-quality signals, not
            # extraction failures, so keep CLI output clean.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", SyntaxWarning)
                tree = ast.parse(text, filename=str(path))
        except SyntaxError:
            tree = None
            parse_errors += 1

        if tree is not None:
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    defs += 1
                elif isinstance(node, ast.ClassDef):
                    classes += 1

            # --- per-file internal structure (symbols + intra-file calls) ----
            symbols = collect_symbols(rel, tree)
            file_symbols[rel] = symbols
            symbol_total += len(symbols)
            symbol_edge_total += sum(len(s["calls"]) for s in symbols)

            # package directory of this file (for relative import resolution).
            # For ``a/b/c.py`` -> ['a','b']; for ``a/b/__init__.py`` -> ['a','b'].
            pkg_parts = parts[:-1]

            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    if node.level and node.level > 0:
                        # relative import: pop (level-1) dirs from package
                        if node.level - 1 > len(pkg_parts):
                            unresolved += 1
                            continue
                        base = pkg_parts[: len(pkg_parts) - (node.level - 1)]
                        mod_parts = node.module.split(".") if node.module else []
                        prefix_parts = base + mod_parts
                    else:
                        module = node.module or ""
                        if module == prefix or module.startswith(prefix + "."):
                            prefix_parts = (
                                []
                                if module == prefix
                                else module[len(prefix) + 1 :].split(".")
                            )
                        else:
                            unresolved += 1
                            continue
                    # "from pkg import name": when pkg is a package, each name
                    # is first tried as a submodule (pkg/name.py); resolved
                    # names edge to the submodule instead of the package
                    # __init__.  When nothing resolves as a submodule the
                    # statement keeps its package/module edge (the names are
                    # then symbols defined there).
                    pkg_target = resolve_parts(prefix_parts)
                    targets = []
                    if pkg_target is not None and pkg_target.endswith("/__init__.py"):
                        for alias in node.names:
                            sub_t = resolve_parts(prefix_parts + [alias.name])
                            if sub_t is not None and sub_t != rel:
                                targets.append(sub_t)
                    if not targets and pkg_target is not None and pkg_target != rel:
                        targets.append(pkg_target)
                    if not targets:
                        unresolved += 1
                    else:
                        raw_edges.extend((rel, t) for t in targets)
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        module = alias.name
                        if module.startswith(prefix + "."):
                            mod_parts = module[len(prefix) + 1 :].split(".")
                            target = resolve_parts(mod_parts)
                        else:
                            unresolved += 1
                            continue
                        if target is None:
                            unresolved += 1
                        elif target != rel:
                            raw_edges.append((rel, target))

        metrics[rel] = {
            "loc": loc,
            "codeLines": code_lines,
            "defs": defs,
            "classes": classes,
            "district": district,
            "sub": sub,
        }
        loc_total += loc
        code_lines_total += code_lines
        def_total += defs
        class_total += classes

    # --- pass 3: aggregate edges -------------------------------------------
    edge_weight = defaultdict(int)
    for src, dst in raw_edges:
        edge_weight[(src, dst)] += 1

    # imports per file (deduped) and fanIn / fanOut
    file_imports = defaultdict(set)
    fan_in = defaultdict(int)
    for (src, dst), _w in edge_weight.items():
        file_imports[src].add(dst)
    for src, dsts in file_imports.items():
        for dst in dsts:
            fan_in[dst] += 1

    # --- pass 4: districts --------------------------------------------------
    district_files = defaultdict(list)     # district -> [file id]
    district_subs = defaultdict(lambda: defaultdict(list))  # district -> sub -> [file id]
    for rel, m in metrics.items():
        district_files[m["district"]].append(rel)
        if m["sub"] is not None:
            district_subs[m["district"]][m["sub"]].append(rel)

    # cross-district file edges -> packageEdges
    package_edge_weight = defaultdict(int)
    for (src, dst), w in edge_weight.items():
        sd = metrics[src]["district"]
        dd = metrics[dst]["district"]
        if sd != dd:
            package_edge_weight[(sd, dd)] += w

    district_fan_out = defaultdict(int)
    district_fan_in = defaultdict(int)
    for (sd, dd), w in package_edge_weight.items():
        district_fan_out[sd] += w
        district_fan_in[dd] += w

    districts_out = []
    for dist in sorted(district_files.keys()):
        fids = district_files[dist]
        loc = sum(metrics[f]["loc"] for f in fids)
        code_lines = sum(metrics[f]["codeLines"] for f in fids)
        defs = sum(metrics[f]["defs"] for f in fids)
        classes = sum(metrics[f]["classes"] for f in fids)
        if dist == "root":
            dist_path = root_label
        else:
            dist_path = root_label + "/" + dist

        subs_out = []
        for sub_name in sorted(district_subs[dist].keys()):
            sub_ids = district_subs[dist][sub_name]
            subs_out.append(
                {
                    "id": sub_name,
                    "name": sub_name,
                    "path": dist_path + "/" + sub_name,
                    "fileCount": len(sub_ids),
                    "loc": sum(metrics[f]["loc"] for f in sub_ids),
                }
            )
        # subs sorted by loc desc, id asc as tie-break
        subs_out.sort(key=lambda s: (-s["loc"], s["id"]))

        files_sorted = sorted(fids, key=lambda f: (-metrics[f]["loc"], f))

        districts_out.append(
            {
                "id": dist,
                "name": dist,
                "path": dist_path,
                "fileCount": len(fids),
                "loc": loc,
                "codeLines": code_lines,
                "defs": defs,
                "classes": classes,
                "fanIn": district_fan_in.get(dist, 0),
                "fanOut": district_fan_out.get(dist, 0),
                "subs": subs_out,
                "files": files_sorted,
            }
        )

    # --- pass 5: files + imports + edges -----------------------------------
    files_out = []
    for rel in sorted(metrics.keys()):
        m = metrics[rel]
        imps = sorted(file_imports.get(rel, set()))
        files_out.append(
            {
                "id": rel,
                "path": root_label + "/" + rel,
                "district": m["district"],
                "sub": m["sub"],
                "loc": m["loc"],
                "codeLines": m["codeLines"],
                "defs": m["defs"],
                "classes": m["classes"],
                "fanOut": len(imps),
                "fanIn": fan_in.get(rel, 0),
                "imports": imps,
                "symbols": file_symbols.get(rel, []),
            }
        )

    imports_out = [
        {"from": src, "to": dst, "weight": w}
        for (src, dst), w in sorted(edge_weight.items())
    ]

    package_edges_out = [
        {"from": s, "to": d, "weight": w}
        for (s, d), w in sorted(package_edge_weight.items())
    ]

    top_files = sorted(
        ({"id": r, "loc": m["loc"]} for r, m in metrics.items()),
        key=lambda x: (-x["loc"], x["id"]),
    )[:20]

    top_fan_in = sorted(
        ({"id": r, "fanIn": fan_in.get(r, 0)} for r in metrics.keys()),
        key=lambda x: (-x["fanIn"], x["id"]),
    )[:20]

    generated_at = (
        datetime.now(timezone.utc).isoformat() if with_timestamp else ""
    )

    return {
        "meta": {
            "root": root_label,
            "generatedAt": generated_at,
            "fileCount": len(file_ids),
            "districtCount": len(district_files),
            "edgeCount": len(edge_weight),
            "locTotal": loc_total,
            "codeLinesTotal": code_lines_total,
            "defTotal": def_total,
            "classTotal": class_total,
            "symbolTotal": symbol_total,
            "symbolEdgeTotal": symbol_edge_total,
            "unresolvedImports": unresolved,
            "parseErrors": parse_errors,
        },
        "districts": districts_out,
        "files": files_out,
        "imports": imports_out,
        "packageEdges": package_edges_out,
        "topFiles": top_files,
        "topFanIn": top_fan_in,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        default=DEFAULT_ROOT,
        help="source root to analyse (read-only); env SGLANG_SRT_ROOT overrides the default",
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help="output JSON path (default: <repo>/data/sglang-graph.json)",
    )
    parser.add_argument(
        "--prefix",
        default=DEFAULT_PREFIX,
        help="absolute import prefix mapped onto the root (default: sglang.srt)",
    )
    parser.add_argument(
        "--root-label",
        default="python/sglang/srt",
        help="label used in meta.root and file/district 'path' fields",
    )
    parser.add_argument(
        "--no-timestamp",
        action="store_true",
        help="emit an empty meta.generatedAt for byte-identical comparability",
    )
    parser.add_argument(
        "--indent", type=int, default=2, help="JSON indentation (default 2)"
    )
    args = parser.parse_args(argv)

    root = Path(args.root)
    if not root.is_dir():
        print(f"error: root not found: {root}", file=sys.stderr)
        return 2

    data = extract(root, args.root_label, args.prefix, with_timestamp=not args.no_timestamp)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # sort_keys=False to preserve our explicit schema field order; newline at EOF.
    with out_path.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=args.indent)
        fh.write("\n")

    m = data["meta"]
    print(
        "fileCount={fileCount} districtCount={districtCount} edgeCount={edgeCount} "
        "locTotal={locTotal} codeLinesTotal={codeLinesTotal} "
        "defTotal={defTotal} classTotal={classTotal} "
        "symbolTotal={symbolTotal} symbolEdgeTotal={symbolEdgeTotal} "
        "unresolvedImports={unresolvedImports}".format(**m)
    )
    print(f"written: {out_path} ({out_path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
