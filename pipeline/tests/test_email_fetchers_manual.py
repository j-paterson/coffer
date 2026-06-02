"""Tests for ManualFetcher (file-drop EmailFetcher backend)."""
import os
import time
from pathlib import Path

import pytest

from finance_pipeline.emails.fetchers.manual import ManualFetcher


def _make_eml(dir: Path, name: str, contents: str = "From: a@b.com\r\n\r\nbody") -> Path:
    p = dir / name
    p.write_text(contents)
    return p


def test_empty_directory_yields_nothing(tmp_path):
    fetcher = ManualFetcher(drop_directory=str(tmp_path))
    assert list(fetcher.fetch_new()) == []


def test_yields_eml_files_in_directory(tmp_path):
    _make_eml(tmp_path, "a.eml")
    _make_eml(tmp_path, "b.eml")
    fetcher = ManualFetcher(drop_directory=str(tmp_path))
    paths = list(fetcher.fetch_new())
    names = sorted(p.name for p in paths)
    assert names == ["a.eml", "b.eml"]


def test_ignores_non_eml_files(tmp_path):
    _make_eml(tmp_path, "good.eml")
    (tmp_path / "noise.txt").write_text("nope")
    (tmp_path / "image.png").write_bytes(b"\x89PNG...")
    fetcher = ManualFetcher(drop_directory=str(tmp_path))
    paths = list(fetcher.fetch_new())
    assert [p.name for p in paths] == ["good.eml"]


def test_yields_in_mtime_order(tmp_path):
    a = _make_eml(tmp_path, "a.eml")
    b = _make_eml(tmp_path, "b.eml")
    # Make `b` older than `a`
    old = time.time() - 1000
    new = time.time()
    os.utime(b, (old, old))
    os.utime(a, (new, new))
    fetcher = ManualFetcher(drop_directory=str(tmp_path))
    paths = list(fetcher.fetch_new())
    assert [p.name for p in paths] == ["b.eml", "a.eml"]


def test_idempotent_across_runs(tmp_path):
    _make_eml(tmp_path, "a.eml")
    fetcher = ManualFetcher(drop_directory=str(tmp_path))
    # First run: yield a.eml, then mark processed
    paths_first = list(fetcher.fetch_new())
    for p in paths_first:
        fetcher.mark_processed(p.name)
    # Second run: must not yield a.eml again
    paths_second = list(fetcher.fetch_new())
    assert [p.name for p in paths_first] == ["a.eml"]
    assert paths_second == []


def test_new_files_after_initial_run_are_yielded(tmp_path):
    _make_eml(tmp_path, "a.eml")
    fetcher = ManualFetcher(drop_directory=str(tmp_path))
    for p in fetcher.fetch_new():
        fetcher.mark_processed(p.name)
    _make_eml(tmp_path, "b.eml")
    paths = list(fetcher.fetch_new())
    assert [p.name for p in paths] == ["b.eml"]


def test_missing_directory_raises_systemexit(tmp_path):
    fetcher = ManualFetcher(drop_directory=str(tmp_path / "does-not-exist"))
    with pytest.raises(SystemExit) as exc_info:
        list(fetcher.fetch_new())
    assert "docs/email.md" in str(exc_info.value)


def test_does_not_delete_source_files(tmp_path):
    _make_eml(tmp_path, "a.eml")
    fetcher = ManualFetcher(drop_directory=str(tmp_path))
    for p in fetcher.fetch_new():
        fetcher.mark_processed(p.name)
    # Source still exists
    assert (tmp_path / "a.eml").exists()


def test_state_file_is_hidden_dotfile(tmp_path):
    _make_eml(tmp_path, "a.eml")
    fetcher = ManualFetcher(drop_directory=str(tmp_path))
    for p in fetcher.fetch_new():
        fetcher.mark_processed(p.name)
    # The state file should be a dotfile, not a normal file
    assert (tmp_path / ".processed").exists()
    # And it should not be returned by fetch_new (it's not .eml anyway)
