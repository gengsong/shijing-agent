# Task format

A task is a YAML file. Relative paths are resolved from the task file's folder.

```yaml
name: Export the release checklist        # optional, shown in the report
goal: Export the task list as a CSV file  # required, what a user is trying to do

targets:                                  # required, one or more
  baseline: ./site/v1/index.html          # local HTML file (served on 127.0.0.1)
  candidate: https://staging.example.com/ # or an http(s) URL

success:                                  # required, at least one check
  download:
    name: "*.csv"                         # glob for the downloaded file name (default "*")
    equals: ./expected/checklist.csv      # optional, byte-for-byte comparison
  text: "Export complete"                 # optional, text the page must show

maxSteps: 10                              # optional, 1-50 (default 12)
viewport: { width: 1280, height: 800 }    # optional
allowWrites: false                        # optional, true allows non-GET requests (staging only)
```

## Targets

- Targets run in file order. The report compares the **first** target (the baseline) with the **last** one (the candidate).
- Each target runs in a fresh browser context. Cookies, storage and downloads are not shared.
- Run a single target with `--target candidate`.

## Success

- With `download`, the run ends at the first download. If the file does not match, the run fails immediately and the report shows the first differing line.
- With `text`, the page text is checked after every action.
- With both, the download must match and the text must also be shown.

## Clicks

Every action the agent performs (a click, or typing into a search box) counts as one. Page loads, dismissed dialogs and closed pop-ups are not counted.

## Writing a good task

- Phrase the goal the way a user would ask for it ("Export the task list as a CSV file"), not as UI instructions ("Click More, then Data management").
- Prefer `equals` over `name` alone: it catches a redesign that looks faster but exports the wrong data.
- Add a control task whose expected result is deliberately wrong (see `examples/export-csv/task.control.yaml`). It must fail. If it passes, your checks are not checking anything.
