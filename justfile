set fallback := true
repo_root := justfile_directory()

justfile-hygiene:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    if [[ -e Justfile ]]; then
      echo "Canonical automation entrypoint is ./justfile; remove ./Justfile." >&2
      exit 1
    fi

install: justfile-hygiene
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec bun install

typecheck: justfile-hygiene
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec direnv exec "{{repo_root}}" bunx tsc --noEmit

test: justfile-hygiene
    #!/usr/bin/env bash
    set -euo pipefail
    root_justfile="{{repo_root}}/../../justfile"

    cleanup() {
      just -f "$root_justfile" test-sandbox-down 2>/dev/null || true
    }
    trap cleanup EXIT

    just -f "$root_justfile" test-sandbox-up "{{repo_root}}/tests/integration/opencode.json" "{{repo_root}}/.envrc"
    direnv exec "{{repo_root}}" bun test tests/integration

test-file file pattern='': justfile-hygiene
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    if [[ -n "{{pattern}}" ]]; then
      exec direnv exec "{{repo_root}}" bun test "{{file}}" --test-name-pattern "{{pattern}}"
    fi
    exec direnv exec "{{repo_root}}" bun test "{{file}}"

check: justfile-hygiene typecheck test

# Setup npm trusted publisher (one-time manual setup)
setup-npm-trust:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec npm trust github --repository "dzackgarza/$(basename "{{repo_root}}")" --file publish.yml

# Manual publish from local (requires 2FA)
publish: check
    npm publish


# Bump patch version, commit, and tag
bump-patch:
    npm version patch --no-git-tag-version
    git add package.json
    git commit -m "chore: bump version to v$(node -p 'require("./package.json").version')"
    git tag "v$(node -p 'require("./package.json").version')"

# Bump minor version, commit, and tag
bump-minor:
    npm version minor --no-git-tag-version
    git add package.json
    git commit -m "chore: bump version to v$(node -p 'require("./package.json").version')"
    git tag "v$(node -p 'require("./package.json").version')"

# Push commits and tags to trigger CI release
release: check
    git push && git push --tags

