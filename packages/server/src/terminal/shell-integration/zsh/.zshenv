typeset -g NEOLIX_SHELL_INTEGRATION_DIR="${${(%):-%N}:A:h}"

if [[ -n "${NEOLIX_ZSH_ZDOTDIR-}" ]]; then
  export ZDOTDIR="${NEOLIX_ZSH_ZDOTDIR}"
else
  unset ZDOTDIR
fi

if [[ -n "${ZDOTDIR-}" ]]; then
  if [[ -f "${ZDOTDIR}/.zshenv" ]]; then
    source "${ZDOTDIR}/.zshenv"
  fi
elif [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv"
fi

source "${NEOLIX_SHELL_INTEGRATION_DIR}/neolix-integration.zsh"
