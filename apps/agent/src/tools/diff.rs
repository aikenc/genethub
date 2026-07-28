//! Line diffing for the `edit` tool. Two outputs: a display diff with line
//! numbers (rendered directly in the UI) and a standard unified patch (for
//! anything that wants to apply or store the change).

const CONTEXT_LINES: usize = 4;
/// Above this the quadratic LCS is not worth it; fall back to whole-file
/// replacement, which still renders correctly.
const MAX_LCS_LINES: usize = 3000;

#[derive(Debug, PartialEq, Eq)]
pub enum Part {
    Equal(Vec<String>),
    Added(Vec<String>),
    Removed(Vec<String>),
}

pub fn diff_lines(old: &str, new: &str) -> Vec<Part> {
    let old_lines: Vec<&str> = split_lines(old);
    let new_lines: Vec<&str> = split_lines(new);

    if old_lines.len() > MAX_LCS_LINES || new_lines.len() > MAX_LCS_LINES {
        let mut parts = Vec::new();
        if !old_lines.is_empty() {
            parts.push(Part::Removed(to_owned(&old_lines)));
        }
        if !new_lines.is_empty() {
            parts.push(Part::Added(to_owned(&new_lines)));
        }
        return parts;
    }

    let table = lcs_table(&old_lines, &new_lines);
    let mut parts: Vec<Part> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);

    while i < old_lines.len() && j < new_lines.len() {
        if old_lines[i] == new_lines[j] {
            push_line(&mut parts, Kind::Equal, old_lines[i]);
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            push_line(&mut parts, Kind::Removed, old_lines[i]);
            i += 1;
        } else {
            push_line(&mut parts, Kind::Added, new_lines[j]);
            j += 1;
        }
    }
    while i < old_lines.len() {
        push_line(&mut parts, Kind::Removed, old_lines[i]);
        i += 1;
    }
    while j < new_lines.len() {
        push_line(&mut parts, Kind::Added, new_lines[j]);
        j += 1;
    }

    parts
}

/// Display diff: `+12 added`, `-12 removed`, ` 12 context`, ` … ...` elisions.
pub fn generate_diff_string(old: &str, new: &str) -> (String, Option<usize>) {
    let parts = diff_lines(old, new);
    let width = split_lines(old)
        .len()
        .max(split_lines(new).len())
        .to_string()
        .len();

    let mut output: Vec<String> = Vec::new();
    let mut old_line = 1usize;
    let mut new_line = 1usize;
    let mut first_changed: Option<usize> = None;
    let mut last_was_change = false;

    for index in 0..parts.len() {
        match &parts[index] {
            Part::Added(lines) => {
                first_changed.get_or_insert(new_line);
                for line in lines {
                    output.push(format!("+{:>width$} {line}", new_line, width = width));
                    new_line += 1;
                }
                last_was_change = true;
            }
            Part::Removed(lines) => {
                first_changed.get_or_insert(new_line);
                for line in lines {
                    output.push(format!("-{:>width$} {line}", old_line, width = width));
                    old_line += 1;
                }
                last_was_change = true;
            }
            Part::Equal(lines) => {
                let next_is_change = matches!(
                    parts.get(index + 1),
                    Some(Part::Added(_)) | Some(Part::Removed(_))
                );
                match (last_was_change, next_is_change) {
                    (true, true) if lines.len() <= CONTEXT_LINES * 2 => {
                        emit_context(&mut output, lines, width, &mut old_line, &mut new_line);
                    }
                    (true, true) => {
                        let skipped = lines.len() - CONTEXT_LINES * 2;
                        emit_context(
                            &mut output,
                            &lines[..CONTEXT_LINES],
                            width,
                            &mut old_line,
                            &mut new_line,
                        );
                        output.push(format!(" {:width$} ...", "", width = width));
                        old_line += skipped;
                        new_line += skipped;
                        emit_context(
                            &mut output,
                            &lines[lines.len() - CONTEXT_LINES..],
                            width,
                            &mut old_line,
                            &mut new_line,
                        );
                    }
                    (true, false) => {
                        let shown = lines.len().min(CONTEXT_LINES);
                        emit_context(
                            &mut output,
                            &lines[..shown],
                            width,
                            &mut old_line,
                            &mut new_line,
                        );
                        if lines.len() > shown {
                            output.push(format!(" {:width$} ...", "", width = width));
                            old_line += lines.len() - shown;
                            new_line += lines.len() - shown;
                        }
                    }
                    (false, true) => {
                        let skipped = lines.len().saturating_sub(CONTEXT_LINES);
                        if skipped > 0 {
                            output.push(format!(" {:width$} ...", "", width = width));
                            old_line += skipped;
                            new_line += skipped;
                        }
                        emit_context(
                            &mut output,
                            &lines[skipped..],
                            width,
                            &mut old_line,
                            &mut new_line,
                        );
                    }
                    (false, false) => {
                        old_line += lines.len();
                        new_line += lines.len();
                    }
                }
                last_was_change = false;
            }
        }
    }

    (output.join("\n"), first_changed)
}

/// Standard unified patch with file headers only, like `createTwoFilesPatch`.
pub fn generate_unified_patch(path: &str, old: &str, new: &str) -> String {
    let parts = diff_lines(old, new);
    let mut hunks: Vec<String> = Vec::new();
    let mut body: Vec<String> = Vec::new();

    let mut old_line = 1usize;
    let mut new_line = 1usize;
    let mut hunk_old_start = 1usize;
    let mut hunk_new_start = 1usize;
    let mut hunk_old_count = 0usize;
    let mut hunk_new_count = 0usize;

    let flush = |body: &mut Vec<String>,
                 hunks: &mut Vec<String>,
                 old_start: usize,
                 new_start: usize,
                 old_count: usize,
                 new_count: usize| {
        if body.is_empty() {
            return;
        }
        hunks.push(format!(
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@\n{}",
            body.join("\n")
        ));
        body.clear();
    };

    for index in 0..parts.len() {
        match &parts[index] {
            Part::Equal(lines) => {
                let leading = if body.is_empty() {
                    0
                } else {
                    CONTEXT_LINES.min(lines.len())
                };
                for line in &lines[..leading] {
                    body.push(format!(" {line}"));
                    hunk_old_count += 1;
                    hunk_new_count += 1;
                }

                let next_is_change = matches!(
                    parts.get(index + 1),
                    Some(Part::Added(_)) | Some(Part::Removed(_))
                );
                let trailing = if next_is_change {
                    CONTEXT_LINES.min(lines.len() - leading)
                } else {
                    0
                };

                if lines.len() - leading > trailing {
                    flush(
                        &mut body,
                        &mut hunks,
                        hunk_old_start,
                        hunk_new_start,
                        hunk_old_count,
                        hunk_new_count,
                    );
                    hunk_old_count = 0;
                    hunk_new_count = 0;
                }

                let trailing_start = lines.len() - trailing;
                if trailing > 0 {
                    hunk_old_start = old_line + trailing_start;
                    hunk_new_start = new_line + trailing_start;
                    for line in &lines[trailing_start..] {
                        body.push(format!(" {line}"));
                        hunk_old_count += 1;
                        hunk_new_count += 1;
                    }
                }

                old_line += lines.len();
                new_line += lines.len();
            }
            Part::Removed(lines) => {
                if body.is_empty() {
                    hunk_old_start = old_line;
                    hunk_new_start = new_line;
                }
                for line in lines {
                    body.push(format!("-{line}"));
                    hunk_old_count += 1;
                    old_line += 1;
                }
            }
            Part::Added(lines) => {
                if body.is_empty() {
                    hunk_old_start = old_line;
                    hunk_new_start = new_line;
                }
                for line in lines {
                    body.push(format!("+{line}"));
                    hunk_new_count += 1;
                    new_line += 1;
                }
            }
        }
    }

    flush(
        &mut body,
        &mut hunks,
        hunk_old_start,
        hunk_new_start,
        hunk_old_count,
        hunk_new_count,
    );

    if hunks.is_empty() {
        return String::new();
    }

    format!("--- {path}\n+++ {path}\n{}\n", hunks.join("\n"))
}

fn emit_context(
    output: &mut Vec<String>,
    lines: &[String],
    width: usize,
    old_line: &mut usize,
    new_line: &mut usize,
) {
    for line in lines {
        output.push(format!(" {:>width$} {line}", old_line, width = width));
        *old_line += 1;
        *new_line += 1;
    }
}

enum Kind {
    Equal,
    Added,
    Removed,
}

fn push_line(parts: &mut Vec<Part>, kind: Kind, line: &str) {
    let line = line.to_string();
    match (kind, parts.last_mut()) {
        (Kind::Equal, Some(Part::Equal(lines)))
        | (Kind::Added, Some(Part::Added(lines)))
        | (Kind::Removed, Some(Part::Removed(lines))) => lines.push(line),
        (Kind::Equal, _) => parts.push(Part::Equal(vec![line])),
        (Kind::Added, _) => parts.push(Part::Added(vec![line])),
        (Kind::Removed, _) => parts.push(Part::Removed(vec![line])),
    }
}

fn lcs_table(old: &[&str], new: &[&str]) -> Vec<Vec<usize>> {
    let mut table = vec![vec![0usize; new.len() + 1]; old.len() + 1];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            table[i][j] = if old[i] == new[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    table
}

fn split_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    content.lines().collect()
}

fn to_owned(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|line| line.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_content_produces_no_changes() {
        let (diff, first) = generate_diff_string("a\nb\n", "a\nb\n");
        assert!(diff.is_empty());
        assert_eq!(first, None);
        assert!(generate_unified_patch("f.txt", "a\nb\n", "a\nb\n").is_empty());
    }

    #[test]
    fn diff_lines_groups_runs() {
        let parts = diff_lines("a\nb\nc\n", "a\nx\nc\n");
        assert_eq!(parts[0], Part::Equal(vec!["a".into()]));
        assert!(matches!(parts[1], Part::Removed(_) | Part::Added(_)));
        assert_eq!(parts.last().unwrap(), &Part::Equal(vec!["c".into()]));
    }

    #[test]
    fn display_diff_marks_lines_with_numbers() {
        let (diff, first) = generate_diff_string("alpha\nbeta\n", "alpha\ngamma\n");
        assert!(diff.contains("-2 beta"), "{diff}");
        assert!(diff.contains("+2 gamma"), "{diff}");
        assert!(diff.contains(" 1 alpha"), "{diff}");
        assert_eq!(first, Some(2));
    }

    #[test]
    fn long_unchanged_regions_are_elided() {
        let old: String = (1..=40).map(|i| format!("line{i}\n")).collect();
        let mut new_lines: Vec<String> = (1..=40).map(|i| format!("line{i}")).collect();
        new_lines[0] = "changed".into();
        new_lines[39] = "changed-end".into();
        let new = format!("{}\n", new_lines.join("\n"));

        let (diff, _) = generate_diff_string(&old, &new);
        assert!(diff.contains("..."), "{diff}");
        assert!(diff.lines().count() < 40);
    }

    #[test]
    fn unified_patch_has_headers_and_hunks() {
        let patch = generate_unified_patch("src/f.rs", "a\nb\nc\n", "a\nB\nc\n");
        assert!(patch.starts_with("--- src/f.rs\n+++ src/f.rs\n"));
        assert!(patch.contains("@@ -1,3 +1,3 @@"), "{patch}");
        assert!(patch.contains("-b"));
        assert!(patch.contains("+B"));
        assert!(patch.contains(" a"));
    }

    #[test]
    fn additions_at_end_are_captured() {
        let (diff, first) = generate_diff_string("a\n", "a\nb\n");
        assert!(diff.contains("+2 b"), "{diff}");
        assert_eq!(first, Some(2));
    }
}
