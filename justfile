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
    cd "{{repo_root}}"
    exec direnv exec "{{repo_root}}" bun test

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
