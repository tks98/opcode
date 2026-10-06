#!/bin/sh
# Creates the practice files used by the `tutorial` command.
set -e
t=$1
mkdir -p "$t"
printf 'The secret word is: penguin\n' > "$t/.secret"
printf 'Not this one. Hidden files start with a dot.\n' > "$t/notes.txt"
printf 'This draft will become your final copy.\n' > "$t/draft.txt"
printf 'Delete me!\n' > "$t/junk.txt"
printf '#!/bin/sh\necho "The magic word is: executable"\n' > "$t/hello.sh"
chmod 644 "$t/hello.sh"

# A maze of directories with one treasure.
for a in north south east west; do
  for b in cave forest river; do
    mkdir -p "$t/maze/$a/$b"
    printf 'Nothing here. Keep looking!\n' > "$t/maze/$a/$b/sign.txt"
  done
done
mkdir -p "$t/maze/west/forest/old-tree"
printf 'You found it! The treasure word is: kernel\n' > "$t/maze/west/forest/old-tree/treasure.txt"

# A haystack with one needle.
mkdir -p "$t/haystack"
i=1
while [ $i -le 40 ]; do
  printf 'hay hay hay straw hay\n' > "$t/haystack/file-$i.txt"
  i=$((i + 1))
done
printf 'hay hay needle hay\n' > "$t/haystack/file-23.txt"
