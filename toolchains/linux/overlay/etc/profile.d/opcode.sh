# Opcode Linux shell defaults.
export EDITOR=nano PAGER=less LESS=-R
if [ -n "$BASH_VERSION" ]; then
  PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
  alias ls='ls --color=auto' ll='ls -la' la='ls -A' grep='grep --color=auto'
  HISTCONTROL=ignoredups
  PROMPT_COMMAND='history -a'
  if [ -f /usr/share/bash-completion/bash_completion ]; then
    . /usr/share/bash-completion/bash_completion
  fi
fi
