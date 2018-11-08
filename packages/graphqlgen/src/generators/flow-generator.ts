import * as os from 'os'
import * as prettier from 'prettier'

import { GenerateArgs, ModelMap, ContextDefinition } from '../types'
import { GraphQLTypeField, GraphQLTypeObject } from '../source-helper'
import { upperFirst } from '../utils'
import {
  getContextName,
  getDistinctInputTypes,
  getModelName,
  InputTypesMap,
  printFieldLikeType,
  renderDefaultResolvers,
  renderEnums,
  TypeToInputTypeAssociation,
} from './common'

export function format(code: string, options: prettier.Options = {}) {
  try {
    return prettier.format(code, {
      ...options,
      parser: 'flow',
    })
  } catch (e) {
    console.log(
      `There is a syntax error in generated code, unformatted code printed, error: ${JSON.stringify(
        e,
      )}`,
    )
    return code
  }
}

export function generate(args: GenerateArgs): string {
  // TODO: Maybe move this to source helper
  const inputTypesMap: InputTypesMap = args.types
    .filter(type => type.type.isInput)
    .reduce((inputTypes, type) => {
      return {
        ...inputTypes,
        [`${type.name}`]: type,
      }
    }, {})

  // TODO: Type this
  const typeToInputTypeAssociation: TypeToInputTypeAssociation = args.types
    .filter(
      type =>
        type.type.isObject &&
        type.fields.filter(
          field => field.arguments.filter(arg => arg.type.isInput).length > 0,
        ).length > 0,
    )
    .reduce((types, type) => {
      return {
        ...types,
        [`${type.name}`]: [].concat(
          ...(type.fields.map(field =>
            field.arguments
              .filter(arg => arg.type.isInput)
              .map(arg => arg.type.name),
          ) as any),
        ),
      }
    }, {})

  return `\
  ${renderHeader(args)}

  ${renderEnums(args)}

  ${renderNamespaces(args, typeToInputTypeAssociation, inputTypesMap)}

  ${renderResolvers(args)}

  `
}

function renderHeader(args: GenerateArgs): string {
  const modelArray = Object.keys(args.modelMap).map(k => args.modelMap[k])
  const modelImports = modelArray
    .map(
      m =>
        `import type { ${m.definition.name} } from '${
          m.importPathRelativeToOutput
        }'`,
    )
    .join(os.EOL)

  return `/* @flow */
// Code generated by github.com/prisma/graphqlgen, DO NOT EDIT.

import type { GraphQLResolveInfo } from 'graphql'
${modelImports}
${renderContext(args.context)}
  `
}

function renderContext(context?: ContextDefinition) {
  if (context) {
    return `import type  { ${getContextName(context)} } from '${
      context.contextPath
    }'`
  }

  return `type ${getContextName(context)} = any`
}

function renderNamespaces(
  args: GenerateArgs,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
): string {
  return args.types
    .filter(type => type.type.isObject)
    .map(type =>
      renderNamespace(type, typeToInputTypeAssociation, inputTypesMap, args),
    )
    .join(os.EOL)
}

function renderNamespace(
  type: GraphQLTypeObject,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
  args: GenerateArgs,
): string {
  const typeName = upperFirst(type.name)

  return `\
    // Types for ${typeName}
    ${renderDefaultResolvers(type, args, `${typeName}_defaultResolvers`)}

    ${renderInputTypeInterfaces(
      type,
      args.modelMap,
      typeToInputTypeAssociation,
      inputTypesMap,
    )}

    ${renderInputArgInterfaces(type, args.modelMap)}

    ${renderResolverFunctionInterfaces(type, args.modelMap, args.context)}

    ${renderResolverTypeInterface(type, args.modelMap, args.context)}

    ${/* TODO renderResolverClass(type, modelMap) */ ''}
  `
}

function renderInputTypeInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
) {
  if (!typeToInputTypeAssociation[type.name]) {
    return ``
  }

  return getDistinctInputTypes(type, typeToInputTypeAssociation, inputTypesMap)
    .map(typeAssociation => {
      return `export interface ${upperFirst(type.name)}_${upperFirst(
        inputTypesMap[typeAssociation].name,
      )} {
      ${inputTypesMap[typeAssociation].fields.map(
        field => `${field.name}: ${printFieldLikeType(field, modelMap)}`,
      )}
    }`
    })
    .join(os.EOL)
}

function renderInputArgInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
): string {
  return type.fields
    .map(field => renderInputArgInterface(type, field, modelMap))
    .join(os.EOL)
}

function renderInputArgInterface(
  type: GraphQLTypeObject,
  field: GraphQLTypeField,
  modelMap: ModelMap,
): string {
  if (field.arguments.length === 0) {
    return ''
  }

  return `
  export interface ${getInputArgName(type, field)} {
    ${field.arguments
      .map(
        arg =>
          `${arg.name}: ${printFieldLikeType(
            arg as GraphQLTypeField,
            modelMap,
          )}`,
      )
      .join(',' + os.EOL)}
  }
  `
}

function renderResolverFunctionInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  return type.fields
    .map(field =>
      renderResolverFunctionInterface(field, type, modelMap, context),
    )
    .join(os.EOL)
}

function renderResolverFunctionInterface(
  field: GraphQLTypeField,
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  const resolverName = `${upperFirst(type.name)}_${upperFirst(
    field.name,
  )}_Resolver`
  const resolverDefinition = `
  (
    parent: ${getModelName(type.type as any, modelMap)},
    args: ${field.arguments.length > 0 ? getInputArgName(type, field) : '{}'},
    ctx: ${getContextName(context)},
    info: GraphQLResolveInfo,
  )
  `
  const returnType = printFieldLikeType(field, modelMap)

  if (type.name === 'Subscription') {
    return `
    export type ${resolverName} = {|
      subscribe: ${resolverDefinition} => AsyncIterator<${returnType}> | Promise<AsyncIterator<${returnType}>>,
      resolve?: ${resolverDefinition} => ${returnType} | Promise<${returnType}>
    |}
    `
  }

  return `
  export type ${resolverName} = ${resolverDefinition} => ${returnType} | Promise<${returnType}>
  `
}

function renderResolverTypeInterface(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  return `
  export interface ${upperFirst(type.name)}_Resolvers {
    ${type.fields
      .map(field =>
        renderResolverTypeInterfaceFunction(field, type, modelMap, context),
      )
      .join(os.EOL)}
  }
  `
}

function renderResolverTypeInterfaceFunction(
  field: GraphQLTypeField,
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  context?: ContextDefinition,
): string {
  const resolverDefinition = `
  (
    parent: ${getModelName(type.type as any, modelMap)},
    args: ${field.arguments.length > 0 ? getInputArgName(type, field) : '{}'},
    ctx: ${getContextName(context)},
    info: GraphQLResolveInfo,
  )`
  const returnType = printFieldLikeType(field, modelMap)

  if (type.name === 'Subscription') {
    return `
    ${field.name}: {|
      subscribe: ${resolverDefinition} => AsyncIterator<${returnType}> | Promise<AsyncIterator<${returnType}>>,
      resolve?: ${resolverDefinition} => ${returnType} | Promise<${returnType}>
    |}
    `
  }
  return `
  ${
    field.name
  }: ${resolverDefinition} => ${returnType} | Promise<${returnType}>,
  `
}

function renderResolvers(args: GenerateArgs): string {
  return `
export interface Resolvers {
  ${args.types
    .filter(type => type.type.isObject)
    .map(type => `${type.name}: ${upperFirst(type.name)}_Resolvers`)
    .join(',' + os.EOL)}
}
  `
}

function getInputArgName(type: GraphQLTypeObject, field: GraphQLTypeField) {
  return `${upperFirst(type.name)}_Args_${upperFirst(field.name)}`
}
