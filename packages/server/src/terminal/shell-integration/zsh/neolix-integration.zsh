if [[ -n "${_NEOLIX_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _NEOLIX_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _NEOLIX_ZSH_COMMAND_ACTIVE=0

function _neolix_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _neolix_precmd() {
  local command_status=$?
  if [[ "$_NEOLIX_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _neolix_osc633 "D;${command_status}"
    _NEOLIX_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _neolix_osc633 "A"
}

function _neolix_preexec() {
  _NEOLIX_ZSH_COMMAND_ACTIVE=1
  _neolix_osc633 "B"
  _neolix_osc633 "C"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _neolix_precmd
add-zsh-hook preexec _neolix_preexec
