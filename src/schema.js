import assert from 'assert' // only defined if needed

import Ajv from 'ajv/dist/2020.js'
import deepcopy from 'rfdc/default'
import traverse from 'traverse'

let ajv

/**
 * Thrown if a compiled schema validator is asked to validate an invalid value.
 */
class ValidationError extends Error {
  /**
   * @param {string} name a user-provided name describing the schema
   * @param {*} badValue the value which did not validate
   * @param {Object} errors how badValue failed to conform to the schema
   * @param {Object} expectedSchema The JSON schema used in schema validation
   */
  constructor (name, badValue, errors, expectedSchema) {
    super(`Validation Error: ${name}`)
    this.badValue = badValue
    this.validationErrors = errors
    this.expectedSchema = expectedSchema
    // istanbul ignore next
    if (['localhost'].includes(process.env.NODE_ENV)) {
      console.error(JSON.stringify(errors, null, 2))
    }
  }
}

const INT32_MAX = Math.pow(2, 31) - 1
const INT32_MIN = -Math.pow(2, 31)
const TIMESTAMP_MIN = '2000-01-01T00:00:00Z'
const TIMESTAMP_MAX = '9999-01-01T00:00:00Z'
const EPOCH_IN_MILLISECONDS_MIN = new Date(TIMESTAMP_MIN).getTime()
const EPOCH_IN_MILLISECONDS_MAX = new Date(TIMESTAMP_MAX).getTime()
const EPOCH_IN_SECONDS_MIN = EPOCH_IN_MILLISECONDS_MIN / 1000
const EPOCH_IN_SECONDS_MAX = EPOCH_IN_MILLISECONDS_MAX / 1000

// javascript is limited in how it can represent >53 bit numbers
// so 2^62 is naturally the best we can do
const INT64_MAX = Math.pow(2, 62)
const INT64_MIN = -Math.pow(2, 62)

/**
 * The base schema object
 */
class BaseSchema {
  /**
   * The json schema type
   */
  static JSON_SCHEMA_TYPE

  /**
   * The max* property name.
   */
  static MAX_PROP_NAME

  /**
   * The min* property name.
   */
  static MIN_PROP_NAME

  /**
   * Constructs a schema object
   */
  constructor () {
    /**
     * Flag to indicate whether an object is a Schema object.
     */
    this.isSchema = true

    /**
     * For compatibility with fluent-schema. Indicates if an object is a
     * fluent-schema object.
     */
    this.isFluentSchema = true

    /**
     * Stores json schema properties, e.g. type, description, maxLength, etc...
     */
    this.__properties = {}

    /** Directly nested schemas that have a $id */
    this.__nestedWith$Id = {}

    /**
     * Indicates whether an object is locked. See {@link lock}.
     */
    this.__isLocked = false
    this.__isOptional = false
    if (this.constructor.JSON_SCHEMA_TYPE) {
      this.__setProp('type', this.constructor.JSON_SCHEMA_TYPE)
    }
  }

  /**
   * Locks a Schema object from modifications.
   */
  lock () {
    this.__isLocked = true
    return this
  }

  /**
   * Sets a value in __properties. Throws if object is locked (unless the
   * property is allowed to be overridden), or property with
   * the same name already exists and override is not allowed.
   * @param {String} name Name of the property
   * @param {*} val The value for the property
   * @param {Object} [options={}]
   * @param {Boolean} [options.allowOverride=false] If true property override
   *   is allowed.
   */
  __setProp (name, val, { allowOverride = false } = {}) {
    assert.ok(name, 'name should be set')
    assert.ok(!this.__isLocked || allowOverride,
      'Schema is locked. Call copy then further modify the schema')
    assert.ok(allowOverride ||
       !Object.prototype.hasOwnProperty.call(this.__properties, name),
      `Property ${name} is already set.`)
    const shouldCopy = this.__isLocked || (allowOverride &&
      Object.prototype.hasOwnProperty.call(this.__properties, name))
    const ret = shouldCopy ? this.copy() : this
    ret.__properties[name] = val
    if (this.__isLocked) {
      ret.lock()
    }
    return ret
  }

  /**
   * @param {String} name Name of a property
   * @return The value associated with name.
   */
  getProp (name) {
    return this.__properties[name]
  }

  /**
   * If property with name does not exist, the default value is set.
   * @param {String} name
   * @param {*} defaultValue
   * @return The value associated with name.
   */
  __setDefaultProp (name, defaultValue) {
    if (!Object.prototype.hasOwnProperty.call(this.__properties, name)) {
      this.__setProp(name, defaultValue)
    }
    return this.getProp(name)
  }

  /**
   * Sets $id.
   * @param {String} id The id of the schema.
   */
  id (id) {
    assert.ok(typeof id === 'string', '$id must be a string.')
    return this.__setProp('$id', id, { allowOverride: true })
  }

  /**
   * Sets a title.
   * @param {String} t The title of the schema.
   */
  title (t) {
    assert.ok(typeof t === 'string', 'Title must be a string.')
    return this.__setProp('title', t, { allowOverride: true })
  }

  /**
   * Sets a description.
   * @param {String|Array<String>} d The description of the schema.
   * @param {formatParagraphOptions} options how to format `d`
   */
  desc (d, options) {
    d = formatParagraph(d, options)
    return this.__setProp('description', d, { allowOverride: true })
  }

  /**
   * Sets a default value for schema.
   *
   * According to JsonSchema, default value is just metadata and does not
   * serve any validation purpose with in JsonSchema. External tools may
   * choose to use this value to setup defaults, and implementations of
   * JsonSchema validator may choose to validate the type of default values,
   * but it's not required. Since when the default is used to populate the
   * json, there will be something downstream that validates the json and
   * catches issues, we omit schema validation for simplicity.
   *
   * @param {*} d The default value.
   */
  default (d) {
    assert(d !== undefined, 'Default value must be defined')
    Object.freeze(d)
    return this.__setProp('default', d)
  }

  getDefault () {
    return this.propertiesIncludingId().default
  }

  hasDefault () {
    return Object.prototype.hasOwnProperty.call(this.propertiesIncludingId(), 'default')
  }

  /**
   * Marks a schema as optional. Schemas are required by default.
   */
  optional () {
    assert(!this.__isLocked, 'Schema is locked.')
    this.__isOptional = true
    return this
  }

  /**
   * Convenient getter indicates if the schema is required / not optional.
   * See {@link optional}.
   */
  get required () {
    return !this.__isOptional
  }

  /**
   * Sets schemas readOnly property.
   * @param {Boolean} [r=true] If the schema value should be readOnly.
   */
  readOnly (r = true) {
    return this.__setProp('readOnly', r)
  }

  /**
   * Updates schemas examples.
   * @param {Array<String|Array<String>>} es A list of examples. Each example
   *   may be a string, or a list of strings.
   * @param {formatParagraphOptions} options how to format each example in `es`
   */
  examples (es, options) {
    assert.ok(Array.isArray(es), 'Examples must be an array')
    es = es.map(e => formatParagraph(e, options))
    return this.__setProp('examples', es, { allowOverride: true })
  }

  /**
   * Returns a JSON Schema. It exists for compatibility with fluent-schema.
   */
  valueOf () {
    return this.jsonSchema()
  }

  /**
   * The visitable in a visitor pattern. Used for exporting schema.
   * @param {Exporter} visitor a schema exporter. @see JSONSchemaExporter
   */
  // istanbul ignore next
  export (visitor) {
    throw new Error('Subclass must override')
  }

  propertiesOrRef (callerSchema) {
    const $id = this.getProp('$id')
    if ($id) {
      callerSchema.__nestedWith$Id[$id] = this
      return {
        $ref: $id,
        description: this.getProp('description'),
        title: this.getProp('title')
      }
    }
    callerSchema.__nestedWith$Id = {
      ...this.__nestedWith$Id,
      ...callerSchema.__nestedWith$Id
    }
    return this.propertiesIncludingId()
  }

  propertiesIncludingId () {
    return this.__properties
  }

  /**
   * @return JSON Schema with the schema version keyword at the root level.
   */
  jsonSchema (autoConvertNestedSchemasToRefs = true) {
    const exporter = new JSONSchemaExporter()
    const ret = exporter.export(this)
    if (!autoConvertNestedSchemasToRefs) {
      // if there are any nested schemas, replace the $ref with the schema
      if (Object.keys(this.__nestedWith$Id).length) {
        // walk the return and look for { $ref: xx }
        const that = this
        traverse(ret).forEach(function (x) {
          // xRest has the custom title and description for the node, if any
          const { $ref, ...xRest } = (x ?? {})
          if ($ref) {
            const schema = that.__nestedWith$Id[$ref]
            if (schema) {
              const { $id, $schema, ...rest } = schema.jsonSchema(false)
              this.update({ ...rest, ...xRest })
            }
          }
        })
      }
    }
    return ret
  }

  /**
   * Returns a validator function which throws ValidationError if the value it
   * is asked to validate does not match the schema.
   *
   * Locks the current schema.
   *
   * @param {string} name the name of this schema (to distinguish errors)
   * @param {*} [compiler] the ajv or equivalent JSON schema compiler to use
   * @param {returnSchemaToo} [returnSchemaToo] whether to return jsonSchema as
   *   well as the validator
   * @returns {Function} call on a value to validate it; throws on error
   */
  compile (name, compiler, returnSchemaToo) {
    if (!name) {
      name = this.getProp('$id')
      assert.ok(name, 'name is required')
    }
    if (!compiler) {
      if (!ajv) {
        ajv = new Ajv({
          allErrors: true,
          useDefaults: true,
          strictSchema: false
        })
      }
      compiler = ajv
    }
    this.lock()
    this.__compiled = true

    // make sure any schemas we depend on are compiled first
    for (const nestedSchema of Object.values(this.__nestedWith$Id)) {
      if (!nestedSchema.__compiled) {
        nestedSchema.compile(undefined, compiler)
      }
    }

    const jsonSchema = this.jsonSchema()
    const $id = this.getProp('$id')
    const cachedValidate = $id ? compiler.getSchema($id) : null
    const validate = cachedValidate ?? compiler.compile(jsonSchema)
    const assertValid = v => {
      if (!validate(v)) {
        throw new ValidationError(name, v, validate.errors, jsonSchema)
      }
    }
    if (returnSchemaToo) {
      return { jsonSchema, assertValid }
    }
    return assertValid
  }

  /**
   * See {@link compile}.
   * @returns {Object} contains jsonSchema and assertValid
   */
  getValidatorAndJSONSchema (name, compiler) {
    return this.compile(name, compiler, true)
  }

  /**
   * @return A copy of the Schema object. Locked objects become unlocked.
   *
   */
  copy () {
    const ret = new this.constructor()
    ret.__nestedWith$Id = { ...this.__nestedWith$Id }
    ret.__properties = deepcopy(this.__properties)
    ret.__isOptional = this.__isOptional
    return ret
  }

  // max / min support
  /**
   * Validate input to min/max.
   * @param {String} name Property name
   * @param {Integer} val A non-negative integer for min/max.
   */
  __validateRangeProperty (name, val) {
    assert.ok(Number.isInteger(val), `${name} must be an integer`)
    assert.ok(val >= 0, `${name} must be a non-negative number`)
  }

  /**
   * Set a min property depending on schema type.
   * @param {Integer} val A non-negative integer for min/max.
   */
  min (val) {
    const name = this.constructor.MIN_PROP_NAME
    assert.ok(name, 'MIN_PROP_NAME not defined')
    this.__validateRangeProperty(name, val)
    const max = this.getProp(this.constructor.MAX_PROP_NAME)
    assert.ok(max === undefined || max >= val, 'min must be less than max')
    return this.__setProp(name, val)
  }

  /**
   * Set a max property depending on schema type.
   * @param {Integer} val A non-negative integer for min/max.
   */
  max (val) {
    const name = this.constructor.MAX_PROP_NAME
    assert.ok(name, 'MAX_PROP_NAME not defined')
    this.__validateRangeProperty(name, val)
    const min = this.getProp(this.constructor.MIN_PROP_NAME)
    assert.ok(min === undefined || min <= val, 'max must be more than min')
    return this.__setProp(name, val)
  }
}

/**
 * The ObjectSchema class.
 */
class ObjectSchema extends BaseSchema {
  static JSON_SCHEMA_TYPE = 'object'
  static MAX_PROP_NAME = 'maxProperties'
  static MIN_PROP_NAME = 'minProperties'

  /**
   * Creates an object schema object.
   * @param {Object} [props={}] Keys must be strings, values must be schema
   *   objects. Passing props is the same as calling S.obj().props(props).
   */
  constructor (props = {}) {
    super()
    this.objectSchemas = {}
    this.patternSchemas = {}
    this.props(props)
  }

  /**
   * Set an object schema's object property.
   * @param {String} name The name of the property.
   * @param {BaseSchema} schema Any subclass of BaseSchema. Schema gets locked.
   */
  prop (name, schema) {
    assert.ok(!this.__isLocked,
      'Schema is locked. Call copy then further modify the schema')
    assert.ok(typeof name === 'string', 'Property name must be strings.')
    const properties = this.__setDefaultProp('properties', {})
    assert.ok(!Object.prototype.hasOwnProperty.call(properties, name),
      `Property with key ${name} already exists`)
    assert.ok(schema !== undefined, `Property ${name} must define a schema`)

    this.objectSchemas[name] = schema.lock()
    properties[name] = schema.propertiesOrRef(this)
    if (schema.required) {
      this.__setDefaultProp('required', []).push(name)
    }
    return this
  }

  /**
   * A mapping of property names to schemas. Calls this.prop() in a loop.
   * @param {Object} props Keys must be strings, values must be schema
   *   objects.
   */
  props (props) {
    for (const [name, p] of Object.entries(props)) {
      this.prop(name, p)
    }
    return this
  }

  /**
   * A mapping of propertyProperties to schemas.
   * @param {Object} props Keys must be regex, values must be schema
   */
  patternProps (props) {
    for (const [name, schema] of Object.entries(props)) {
      const properties = this.__setDefaultProp('patternProperties', {})
      assert.ok(!Object.prototype.hasOwnProperty.call(properties, name),
        `Pattern ${name} already exists`)
      const anchoredName = getAnchoredPattern(name)
      this.patternSchemas[anchoredName] = schema.lock()
      properties[anchoredName] = schema.propertiesOrRef(this)
    }
    return this
  }

  copy () {
    const ret = super.copy()
    Object.assign(ret.objectSchemas, this.objectSchemas)
    Object.assign(ret.patternSchemas, this.patternSchemas)
    if (this.additionalProperties) {
      ret.additionalProperties = this.additionalProperties
    }
    return ret
  }

  propertiesIncludingId () {
    const ret = super.propertiesIncludingId()
    // Allow any key if no key is defined.
    const hasProperty = Object.keys(this.objectSchemas).length > 0 ||
      Object.keys(this.patternSchemas).length > 0
    const hasAdditionalProperties = !!this.additionalProperties // make it bool
    ret.additionalProperties = !hasProperty || hasAdditionalProperties
    return ret
  }

  export (visitor) {
    return visitor.exportObject(this)
  }
}

/**
 * A polymorphic type.
 *
 * The properties it contains will be based on its type. The type is determined
 * by a specific property (by default named "type").
 */
class PolymorphicObjectSchema extends ObjectSchema {
  static JSON_SCHEMA_TYPE = 'object'
  static MAX_PROP_NAME = 'maxProperties'
  static MIN_PROP_NAME = 'minProperties'

  /**
   * Creates an object schema object.
   * @param {Object} [commonProps={}] Keys must be strings, values must be
   *   schema objects. Passed directly to the S.obj() constructor.
   * @param {Object} [typeNameToObj={}] Keys are strings which are valid type
   *   names for this polymorphic object. Values are S.obj.
   * @param {String} [typeKey='type'] The name of the property which
   *   determines which type of data this object has (all objects will have
   *   this property in addition to what's in commonProps).
   */
  constructor (commonProps = {}, typeNameToObj, typeKey) {
    super(commonProps)
    if (typeNameToObj === undefined) {
      return this // copy() will set up the rest
    }
    this.__allowedTypeNames = Object.keys(typeNameToObj)
    this.__allowedTypeNames.sort()
    assert.ok(this.__allowedTypeNames.length > 0, 'must have at least one type')
    this.prop(typeKey, S.str.enum(this.__allowedTypeNames))
    this.typeKey = typeKey
    this.typeNameToExtraProps = {}
    for (const typeName of this.__allowedTypeNames) {
      let objSchema = typeNameToObj[typeName]
      // propSchema must be an S.obj (not S.polymorphicObj) or a plain old
      // javascript object that can be turned into an S.obj
      if (typeof objSchema === 'object') {
        objSchema = S.obj(objSchema)
      }
      assert.ok(Object.getPrototypeOf(objSchema) === ObjectSchema.prototype,
        'polymorphic object sub-types must be S.obj')
      objSchema.lock()
      const { $id, type, ...relevantProperties } = objSchema.propertiesIncludingId()
      // additional properties constraint is enforced (or not) by the root
      // polymorphic object only (ignored on sub-types)
      delete relevantProperties.additionalProperties
      if (Object.keys(relevantProperties).length > 0) {
        this.typeNameToExtraProps[typeName] = relevantProperties
      }
    }
  }

  copy () {
    const ret = super.copy()
    ret.__allowedTypeNames = deepcopy(this.__allowedTypeNames)
    ret.typeKey = this.typeKey
    ret.typeNameToExtraProps = deepcopy(this.typeNameToExtraProps)
    return ret
  }

  propertiesIncludingId () {
    const ret = super.propertiesIncludingId()
    let cur = ret
    for (const typeName of this.__allowedTypeNames) {
      const extraProps = this.typeNameToExtraProps[typeName]
      if (!extraProps) {
        continue
      }
      if (cur.if) {
        cur.else = {}
        cur = cur.else
      }
      cur.if = { properties: { [this.typeKey]: { const: typeName } } }
      cur.then = extraProps
    }
    // when using applicator keywords like "if" we need to use
    // unevaluatedProperties instead of additionalProperties (because the check
    // needs to happen after the applicators have finalized the properties)
    ret.unevaluatedProperties = ret.additionalProperties
    delete ret.additionalProperties
    return ret
  }
}

/**
 * A schema which is a union of two or more other schemas.
 */
class UnionSchema extends BaseSchema {
  constructor (...schemas) {
    super()
    this.__setProp('type', [])
    this.__schemas = []
    for (const schema of schemas) {
      this.addSchema(schema)
    }
  }

  addSchema (schema) {
    assert.ok(!this.__isLocked,
      'Schema is locked. Call copy then further modify the schema')
    assert.ok(schema instanceof BaseSchema,
      'UnionSchema only works with schema objects')
    schema.lock()
    this.__schemas.push(schema)
    schema.propertiesOrRef(this) // update __nestedWith$Id
    assert.ok(schema.constructor.JSON_SCHEMA_TYPE, 'must provide a concrete type')
    this.getProp('type').push(schema.constructor.JSON_SCHEMA_TYPE)
    return this
  }

  export (visitor) {
    return visitor.exportUnion(this)
  }

  copy () {
    const ret = super.copy()
    ret.__schemas = this.__schemas.map(x => x.copy())
    return ret
  }

  propertiesIncludingId () {
    const ret = {}
    for (const schema of this.__schemas) {
      Object.assign(ret, schema.propertiesIncludingId())
    }
    delete ret.$id // don't copy $id from sub schema
    const myProps = super.propertiesIncludingId()
    return { ...ret, ...myProps }
  }
}

class NullSchema extends BaseSchema {
  static JSON_SCHEMA_TYPE = 'null'

  export (visitor) {
    return visitor.exportNull(this)
  }
}

class NullableSchema extends UnionSchema {
  constructor (schema) {
    super(new NullSchema(), schema)
  }
}

/**
 * The ArraySchema class.
 */
class ArraySchema extends BaseSchema {
  static JSON_SCHEMA_TYPE = 'array'
  static MAX_PROP_NAME = 'maxItems'
  static MIN_PROP_NAME = 'minItems'

  /**
   * Creates an array schema object.
   * @param {BaseSchema} [items] An optional parameter to items(). If provided,
   *   it is the same as calling S.arr().items(items).
   */
  constructor (items) {
    super()
    this.itemsSchema = undefined
    if (items) {
      this.items(items)
    }
  }

  /**
   * Set the schema for items in array
   * @param {BaseSchema} items Any subclass of BaseSchema. Schema gets locked.
   */
  items (items) {
    assert.ok(!this.itemsSchema, 'Items is already set.')
    this.itemsSchema = items.lock()
    this.__setProp('items', items.propertiesOrRef(this))
    return this
  }

  copy () {
    const ret = super.copy()
    ret.itemsSchema = this.itemsSchema
    return ret
  }

  export (visitor) {
    return visitor.exportArray(this)
  }
}

/**
 * The NumberSchema class.
 */
class NumberSchema extends BaseSchema {
  static JSON_SCHEMA_TYPE = 'number'
  static MAX_PROP_NAME = 'maximum'
  static MIN_PROP_NAME = 'minimum'

  constructor () {
    super()
    this.__isFloat = false
  }

  /**
   * Validate input to min/max.
   * @param {String} name Property name
   * @param {Integer} val A finite number for min/max.
   */
  __validateRangeProperty (name, val) {
    assert.ok(Number.isFinite(val), `${name} must be a number`)
  }

  asFloat () {
    assert(!this.__isLocked, 'Schema is locked')
    this.__isFloat = true
    return this
  }

  get isFloat () {
    return this.__isFloat
  }

  export (visitor) {
    return visitor.exportNumber(this)
  }

  copy () {
    const ret = super.copy()
    ret.__isFloat = this.__isFloat
    return ret
  }
}

/**
 * The IntegerSchema class.
 */
class IntegerSchema extends NumberSchema {
  static JSON_SCHEMA_TYPE = 'integer'

  /**
   * Validate input to min/max.
   * @param {String} name Property name
   * @param {Integer} val An integer for min/max.
   */
  __validateRangeProperty (name, val) {
    assert.ok(Number.isInteger(val), `${name} must be an integer`)
  }

  /**
   * sets limit on how large max or min can be.
   * Validates current min/max to ensure they work correctly
   */
  __setSafeRangeLimit (val) {
    const max = this.getProp(this.constructor.MAX_PROP_NAME)
    if (max === undefined) {
      this.max(val)
    } else {
      assert.ok(max <= val, `max cannot exceed ${val}`)
    }
    const min = this.getProp(this.constructor.MIN_PROP_NAME)
    if (min === undefined) {
      this.min(-val)
    } else {
      assert.ok(min >= -val, `min must be larger than ${-val}`)
    }
    return this
  }

  /**
   * applies range for Int32 values
   */
  asInt32 () {
    return this.__setSafeRangeLimit(INT32_MAX)
  }

  /**
   * applies range for int64 values
   */
  asInt64 () {
    return this.__setSafeRangeLimit(INT64_MAX)
  }

  asFloat = undefined

  export (visitor) {
    return visitor.exportInteger(this)
  }
}

/**
 * The StringSchema class.
 */
class StringSchema extends BaseSchema {
  static JSON_SCHEMA_TYPE = 'string'
  static MAX_PROP_NAME = 'maxLength'
  static MIN_PROP_NAME = 'minLength'

  /**
   * Set valid values for the string schema.
   * @param {Array<String>} validValues Valid values for the string. There must
   *   be at least 2 valid values.
   */
  enum (validValues) {
    const values = Array.isArray(validValues) ? validValues : [...arguments]
    assert(values.length >= 1, 'Enum must contain at least 1 value.')
    return this.__setProp('enum', values)
  }

  /**
   * A pattern for the string.
   * @param {String|RegExp} pattern The pattern for the string. Can be a string
   *   with regex syntax, or a RegExp object.
   */
  pattern (pattern) {
    if (pattern instanceof RegExp) {
      pattern = pattern.source
    }
    assert(typeof pattern === 'string', 'Pattern must be a string')
    const anchoredPattern = getAnchoredPattern(pattern)
    return this.__setProp('pattern', anchoredPattern)
  }

  export (visitor) {
    return visitor.exportString(this)
  }
}

/**
 * The BooleanSchema class.
 */
class BooleanSchema extends BaseSchema {
  static JSON_SCHEMA_TYPE = 'boolean'

  export (visitor) {
    return visitor.exportBoolean(this)
  }
}

/**
 * For making $ref references to other schema's $id
 */
class RefSchema extends BaseSchema {
  constructor (ref) {
    super()
    this.__setProp('$ref', ref)
  }

  export (visitor) {
    return visitor.exportRef(this)
  }
}

/**
 * For making const values.
 */
class ConstSchema extends BaseSchema {
  constructor (constValue) {
    super()
    this.__setProp('const', constValue)
  }

  export (visitor) {
    return visitor.exportConst(this)
  }
}

/**
 * Represents an enum containing arbitrary types.
 */
class EnumSchema extends BaseSchema {
  constructor (validValues) {
    super()
    const values = Array.isArray(validValues) ? validValues : [...arguments]
    assert(values.length >= 1, 'Enum must contain at least 1 value.')
    this.__setProp('enum', values)
  }

  export (visitor) {
    return visitor.exportEnum(this)
  }
}

/**
 * The MapSchema class.
 */
class MapSchema extends ObjectSchema {
  constructor () {
    super()
    // deprecate obj methods
    this.prop = undefined
    this.props = undefined
    this.patternProps = undefined

    this.finalized = false
    this.keySchema = undefined
    this.valueSchema = undefined
  }

  /**
   * Set a key pattern for the map.
   * @param {String} keyPattern A pattern for keys
   */
  keyPattern (pattern) {
    assert(!this.keySchema, 'key pattern already set')
    this.keySchema = S.str.pattern(pattern).lock()
    this.__tryFinalizeSchema()
    return this
  }

  /**
   * Set a value schema for the map.
   * @param {BaseSchema} value Any subclass of BaseSchema for the values of map
   */
  value (value) {
    assert(!this.valueSchema, 'value schema already set')
    assert(value.required, 'value must be required')
    this.valueSchema = value.lock()
    this.__tryFinalizeSchema()
    return this
  }

  lock () {
    this.__finalizeSchema()
    return super.lock()
  }

  __finalizeSchema () {
    assert(this.valueSchema, 'Must have a value schema')
    if (!this.keySchema) {
      this.keySchema = S.str
    }
    this.__tryFinalizeSchema()
  }

  __tryFinalizeSchema () {
    if (this.keySchema && this.valueSchema && !this.finalized) {
      this.finalized = true
      super.patternProps({
        [this.keySchema?.getProp('pattern') ?? '.*']: this.valueSchema
      })
    }
  }

  export (visitor) {
    this.__finalizeSchema()
    return visitor.exportMap(this)
  }

  copy () {
    const ret = super.copy()
    ret.finalized = this.finalized
    ret.keySchema = this.keySchema.copy()
    ret.valueSchema = this.valueSchema.copy()
    return ret
  }
}

class MediaSchema extends StringSchema {
  type (t) {
    this.__setProp('contentMediaType', t)
    return this
  }

  encoding (e) {
    assert(['binary', 'base64', 'utf-8'].includes(e),
      'Encoding must be binary, base64 or utf-8')
    this.__setProp('contentEncoding', e)
    return this
  }

  export (visitor) {
    return visitor.exportMedia(this)
  }
}

class JSONSchemaExporter {
  constructor () {
    const methods = [
      'exportString',
      'exportInteger',
      'exportNumber',
      'exportObject',
      'exportArray',
      'exportBoolean',
      'exportConst',
      'exportEnum',
      'exportMap',
      'exportMedia',
      'exportNull',
      'exportRef',
      'exportUnion'
    ]

    for (const method of methods) {
      Object.defineProperty(this, method, {
        get: () => {
          return schema => schema.propertiesIncludingId()
        }
      })
    }
  }

  export (schema) {
    const ret = deepcopy(schema.export(this))
    ret.$schema = 'https://json-schema.org/draft/2020-12/schema'
    return ret
  }
}

/**
 * Options to format a paragraph
 *
 * @typedef {Object} formatParagraphOptions
 * @property {String|false} replaceNewlines if not false, then newlines
 *   will be replaced with this character
 * @property {boolean} trim whether to trim whitespace from the start/end (for
 *   arrays, each element will be trimmed too)
 * @public
 */
/**
 * Formats a paragraph into a string.
 *
 * @param {String|Array<String>} p the string or array of strings to process
 * @param {formatParagraphOptions} options how to format the string
 * @returns {String} formatted string
 */
function formatParagraph (p, { replaceNewlines = ' ', trim = true } = {}) {
  if (!Array.isArray(p)) {
    p = p.split('\n')
  }
  if (trim) {
    p = p.map(x => x.trim())
  }
  let s = p.join('\n')
  if (replaceNewlines !== false) {
    s = s.replace(/\n/g, replaceNewlines)
  }
  if (trim) {
    s = s.trim()
  }
  return s
}

function makeProxyForS (methodName, value) {
  const pendingChanges = { [methodName]: value }
  function applyPendingChanges (schema) {
    for (const [k, v] of Object.entries(pendingChanges)) {
      schema[k](v)
    }
    return schema
  }

  const proxy = new Proxy(S, {
    get: (target, key) => {
      // avoid recursively making proxies
      const proxiedMethods = ['id', 'desc', 'title']
      if (proxiedMethods.includes(key)) {
        return arg => {
          pendingChanges[key] = arg
          return proxy
        }
      }

      if (typeof target[key] === 'function') {
        return (...args) => applyPendingChanges(target[key](...args))
      }
      return applyPendingChanges(target[key][methodName](value))
    }
  })
  return proxy
}

/**
 * The S object to be exported.
 * Noteworthily, it is safe to deprecate certain schema types simply by
 * deleting the corresponding accessor.
 */
export default class S {
  static desc (description) { return makeProxyForS('desc', description) }
  static id (id) { return makeProxyForS('id', id) }
  static title (title) { return makeProxyForS('title', title) }

  /**
   * @param {Object} object See {@link ObjectSchema#constructor}
   * @return A new ObjectSchema object.
   */
  static obj (object) { return new ObjectSchema(object) }

  /**
   * @param {Object} object See {@link ObjectSchema#constructor}
   * @return A new ObjectSchema object.
   */
  static polymorphicObj ({ commonProps = {}, typeNameToObj = {}, typeKey = 'type' } = {}) {
    return new PolymorphicObjectSchema(commonProps, typeNameToObj, typeKey)
  }

  /**
   * @param {BaseSchema} schema See {@link ArraySchema#constructor}
   * @return A new ArraySchema object.
   */
  static arr (schema) { return new ArraySchema(schema) }

  /**
   * Get a new NumberSchema object.
   */
  static get double () { return new NumberSchema() }

  /**
   * Get a new IntegerSchema object.
   */
  static get int () { return new IntegerSchema() }

  /**
   * Get a new StringSchema object.
   */
  static get str () { return new StringSchema() }

  /**
   * Get a new BooleanSchema object.
   */
  static get bool () { return new BooleanSchema() }

  /**
   * Get a new RefSchema object.
   */
  static ref (idBeingReferenced) { return new RefSchema(idBeingReferenced) }

  /**
   * Get a new num.
   */
  static enum (...allowedValues) { return new EnumSchema(...allowedValues) }

  /**
   * Get a new const schema.
   */
  static const (constValue) { return new ConstSchema(constValue) }

  /**
   * Get a new MapSchema object.
   */
  static get map () { return new MapSchema() }

  /**
   * Get a new MediaSchema object.
   */
  static get media () { return new MediaSchema() }

  /**
   * Gets the schema for null (a constant).
   */
  static get null () { return new NullSchema() }

  /**
   * Gets a schema which is a union of two or more schemas.
   */
  static union (...schemas) { return new UnionSchema(...schemas) }

  /**
   * Returns a schema which is either null or the specified schema.
   */
  static nullable (schema) { return new NullableSchema(schema) }

  /**
   * Lock all schemas in a dictionary (in-place).
   * @param {Object<Schema>} schemas a map of schema values
   * @returns the input map of schema values
   */
  static lock (schemas) {
    Object.values(schemas).forEach(x => x.lock())
    return schemas
  }

  /**
   * Sets all schemas as optional (in-place).
   * @param {Object<Schema>} schemas a map of schema values
   * @returns the input map of schema values
   */
  static optional (schemas) {
    Object.values(schemas).forEach(x => x.optional())
    return schemas
  }

  static PATTERN = {
    UUID_PATTERN: /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
  }

  /**
   * Common schemas.
   */
  static SCHEMAS = S.lock({
    UUID: S.str.desc('An UUID. It is normally generated by calling uuidv4().')
      .pattern(S.PATTERN.UUID_PATTERN),
    STR_ANDU: S.str.desc('Only hyphens, underscores, letters and numbers are permitted.')
      .pattern(/^[-_a-zA-Z0-9]+$/),
    // oversimplified, quick regex to check that a string looks like an email
    STR_EMAIL: S.str.pattern(/^\S+@\S+$/)
      .desc('an e-mail address (no whitespace)').lock(),
    STR_EMAIL_LOWER: S.str.pattern(/^[^\sA-Z]+@[^\sA-Z]+$/)
      .desc('an e-mail address in lowercase (no whitespace)').lock(),
    TIMESTAMP: S.str
      .pattern(/\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d{3}Z/)
      .desc(`An UTC timestamp with millisecond precision, for example,
        2021-02-15T20:15:59.321Z`),
    TIMESTAMP_WITH_TZ: S.str
      .pattern(/\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d(\.\d*)?([+-][0-2]\d:[0-5]\d|Z)/)
      .desc(`Timestamp with time zone and optional millisecond precision,
        for example,
        2021-02-15T20:15:59Z,
        2022-09-15T16:48:28.9097226Z,
        2021-02-15T11:55:20-05:00,
        2021-02-15T11:55:20.9097226+08:00`),
    EPOCH_IN_SECONDS: S.int.min(EPOCH_IN_SECONDS_MIN)
      .max(EPOCH_IN_SECONDS_MAX).desc(`Unix epoch time format in seconds from
        ${TIMESTAMP_MIN} to ${TIMESTAMP_MAX}.`),
    EPOCH_IN_MILLISECONDS: S.int.min(EPOCH_IN_MILLISECONDS_MIN)
      .max(EPOCH_IN_MILLISECONDS_MAX).desc(`Unix epoch time format in
        milliseconds from ${TIMESTAMP_MIN} to ${TIMESTAMP_MAX}.`).asInt64()
  })

  /** Thrown if validation fails. */
  static ValidationError = ValidationError

  static INT32_MAX = INT32_MAX

  static INT32_MIN = INT32_MIN

  static INT64_MAX = INT64_MAX

  static INT64_MIN = INT64_MIN
}

function getAnchoredPattern (pattern) {
  let anchoredName = pattern
  if (pattern[0] !== '^') {
    anchoredName = '^' + pattern
  }
  if (pattern[pattern.length - 1] !== '$') {
    anchoredName += '$'
  }
  return anchoredName
}
