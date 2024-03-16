import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import stringify from 'json-stable-stringify'
import deepcopy from 'rfdc/default'
import yargs from 'yargs/yargs'

import S from '../src/schema.js'

const exampleSchemaSrc = '/path/to/mySchema.js'
const exampleSchemaId = '/someSchema$Id'
const exampleSrcAndId = `${exampleSchemaSrc} ${exampleSchemaId}`
const argv = yargs(process.argv.slice(2))
  .usage(`$0 <jsSchemaPath> [jsonSchemaId]:

To list the schemas imported from jsSchemaPath:
$0 ${exampleSchemaSrc}

To validate a JSON file:
cat file.json | $0 ${exampleSrcAndId} /someSchema$Id

To output a JSON schema (the -flat suffix resolves $ref into their schema for
$ref whose schemas are known):
$0 ${exampleSrcAndId} --to-json-schema[-flat]`)
  .option('--build', {
    describe: 'output all JSON schemas to the specified folder',
    type: 'string',
    demandOption: false
  })
  .option('--to-json-schema', {
    describe: 'output the specified JSON schema',
    type: 'boolean',
    demandOption: false
  })
  .option('--to-json-schema-flat', {
    describe: 'output will replace $ref with the schemas (if known)',
    type: 'boolean',
    demandOption: false
  })
  .option('--add-md5', {
    describe: 'include an md5 property for every schema that is an object that is hash of the functional definition of the schema',
    type: 'boolean',
    demandOption: false
  })
  .demandCommand(1, 2)
  .help(true)
  .strict()
  .parse()

// import the schemas from the specified file
const jsSchemaSrc = path.join(process.cwd(), argv._[0])
const { default: defaultExports, ...otherExports } = await import(jsSchemaSrc)
const allExports = { ...defaultExports, ...otherExports }

// compute a mapping from schema $id (if present) for each schema object
const idToSchema = {}
for (const schema of Object.values(allExports)) {
  if (schema.isSchema) {
    const id = schema.__properties.$id
    if (id) {
      idToSchema[id] = schema
    }
  }
}

function pruneNonFunctionalElements (x) {
  if (!x) {
    return
  }
  for (const k of ['$id', 'title', 'description', 'examples']) {
    delete x[k]
  }
  if (x.type === 'object' || x.properties) {
    for (const valueSchema of Object.values(x.properties ?? {})) {
      pruneNonFunctionalElements(valueSchema)
    }
    for (const valueSchema of Object.values(x?.patternProperties ?? {})) {
      pruneNonFunctionalElements(valueSchema)
    }
    pruneNonFunctionalElementsFromIfThen(x)
  } else if (x.type === 'array') {
    pruneNonFunctionalElements(x.items)
  }
  return x
}
function pruneNonFunctionalElementsFromIfThen (x) {
  if (!x) {
    return
  }
  pruneNonFunctionalElements(x.if)
  pruneNonFunctionalElements(x.then)
  pruneNonFunctionalElementsFromIfThen(x.else)
}

// if there was only a single argument to our script, then just print the list
// of schemas (or build them)
const flat = argv.toJsonSchemaFlat === true
const addMD5ToObjects = argv.addMd5 === true
if (argv._.length === 1) {
  if (argv.build) {
    for (const [id, schema] of Object.entries(idToSchema)) {
      const jsonObj = schema.jsonSchema(!flat)
      let outputJsonObj = jsonObj
      if (addMD5ToObjects && jsonObj.type === 'object') {
        const flatObj = flat ? jsonObj : schema.jsonSchema(false)
        const prunedObj = pruneNonFunctionalElements(deepcopy(flatObj))
        const prunedJsonStr = stringify(prunedObj)
        const functionalMD5 = crypto.createHash('md5').update(prunedJsonStr).digest('hex')
        const fullMD5 = crypto.createHash('md5').update(stringify(flatObj)).digest('hex')
        const jsonObjWithMD5s = deepcopy(jsonObj)
        jsonObjWithMD5s.properties.md5_functional = {
          const: functionalMD5,
          description: 'MD5 of the functional aspects of this schema'
        }
        jsonObjWithMD5s.properties.md5_full = {
          const: fullMD5,
          description: 'MD5 of the all aspects of this schema (including non-functional elements like documentation)'
        }
        outputJsonObj = jsonObjWithMD5s
      }
      const outputJsonStr = stringify(outputJsonObj, { space: 2 })
      let ft = id.replace(/[/]/g, '_')
      if (id[0] === '/') {
        ft = ft.substring(1)
      }
      const outputFilename = path.join(argv.build, ft + '.schema.json')
      fs.writeFileSync(outputFilename, outputJsonStr)
    }
  } else {
    console.log('JSON Schema IDs:')
    const sortedSchemaIds = Object.keys(idToSchema).sort()
    console.log(sortedSchemaIds.map(x => '\t' + x).join('\n'))
  }
  process.exit(0)
}

// if there was a second argument, it was a schema $id; make sure that $id was
// one of the schemas we found in jsSchemaSrc
const jsonSchemaId = argv._[1]
const selectedSchema = idToSchema[jsonSchemaId]
if (!selectedSchema) {
  console.error('unknown JSON Schema ID: ')
  process.exit(1)
}

if (argv.toJsonSchema || argv.toJsonSchemaFlat) {
  // output the JSON schema for the selected schema
  console.log(JSON.stringify(selectedSchema.jsonSchema(!flat), null, 2))
} else {
  // validate the input from stdin against the selected schema
  const validate = selectedSchema.compile(jsonSchemaId)
  const data = fs.readFileSync('/dev/stdin', 'utf-8')
  const json = JSON.parse(data)
  try {
    validate(json)
    console.log('Success!')
  } catch (e) {
    if (e instanceof S.ValidationError) {
      const { validationErrors } = e
      const x = validationErrors[0]
      console.error(`Validation Error at ${x.schemaPath}: ${x.message}`)
      console.error(e)
      process.exit(2)
    } else {
      throw e
    }
  }
}
