# Records the README demo. Run from the repository root after `npm run build`:
#
#   vhs demo/demo.tape

Output demo/demo.gif

Require node
Require git

Set Shell "bash"
Set FontSize 20
Set Width 1100
Set Height 470
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms
Set CursorBlink false

Hide
Type "R=$PWD && demo/setup.sh /tmp/demo > /dev/null && cd /tmp/demo/acme-web || exit 1" Enter
Type `export SKILLENV_HOME=/tmp/demo/home PS1='\[\e[1;36m\]acme-web\[\e[0m\] $ '` Enter
Type `skillenv() { node "$R/dist/cli.js" "$@"; }` Enter
Type "clear" Enter
Sleep 500ms
Show

Sleep 800ms
Type "skillenv env list"
Sleep 400ms
Enter
Sleep 2s

Type "skillenv use frontend"
Sleep 400ms
Enter
Sleep 2s

Type "ls .claude/skills"
Sleep 400ms
Enter
Sleep 2s

Type "git status    # your agent sees them, Git doesn't"
Sleep 600ms
Enter
Sleep 3500ms

Type "clear" Enter
Type "skillenv use review"
Sleep 400ms
Enter
Sleep 2s

Type "skillenv status"
Sleep 400ms
Enter
Sleep 3s

Type "skillenv deactivate"
Sleep 400ms
Enter
Sleep 1500ms

Type "git status --short    # back to a clean project"
Sleep 600ms
Enter
Sleep 4s
