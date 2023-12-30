#!/bin/bash
cd "`dirname \"$0\"`"
script_path="`pwd`"

cd ..
embed-markdown # Update .md files before embedding the .md files into docs

cd "$script_path"
rm -rf generated
npx jsdoc --configure jsdoc.config.json `find ../src -name '*.js' -type f`

if [ "$GITHUB_SHA" = "" ]; then
    gitHash=`git rev-parse HEAD`
else
    gitHash=$GITHUB_SHA
fi
newLine="Generated from <a href=\"https:\\/\\/github.com\\/dound\\/fastify-firestore-service\\/tree\\/$gitHash\">$gitHash<\\/a><\\/article>"
cat ./generated/index.html | sed -e "s/[<][/]article[>]/$newLine/g" > tmp
mv tmp ./generated/index.html
