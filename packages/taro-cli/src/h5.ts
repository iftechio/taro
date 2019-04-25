import { PageConfig } from '@tarojs/taro'
import * as wxTransformer from '@tarojs/transformer-wx'
import * as babel from 'babel-core'
import traverse, { NodePath } from 'babel-traverse'
import * as t from 'babel-types'
import generate from 'better-babel-generator'
import * as chokidar from 'chokidar'
import * as fs from 'fs-extra'
import * as klaw from 'klaw'
import * as _ from 'lodash'
import * as path from 'path'
import * as rimraf from 'rimraf'
import { promisify } from 'util'

import CONFIG from './config'
import { copyFiles, isAliasPath, isNpmPkg, printLog, promoteRelativePath, replaceAliasPath, resolveScriptPath, recursiveMerge } from './util'
import {
  convertAstExpressionToVariable as toVar,
  convertObjectToAstExpression as objToAst,
  convertSourceStringToAstExpression as toAst
} from './util/astConvert'
import { BUILD_TYPES, processTypeEnum, PROJECT_CONFIG, REG_SCRIPTS, REG_TYPESCRIPT } from './util/constants'
import * as npmProcess from './util/npm'
import { IBuildConfig } from './util/types'

const addLeadingSlash = path => path.charAt(0) === '/' ? path : '/' + path
const removeLeadingSlash = path => path.replace(/^\.?\//, '')
const stripTrailingSlash = path => path.charAt(path.length - 1) === '/' ? path.slice(0, -1) : path

const appPath = process.cwd()
const projectConfig = require(path.join(appPath, PROJECT_CONFIG))(_.merge)
const h5Config = projectConfig.h5 || {}
const routerConfig = h5Config.router || {}
const routerMode = routerConfig.mode === 'browser' ? 'browser' : 'hash'
const customRoutes = routerConfig.customRoutes || {}
const routerBasename = addLeadingSlash(stripTrailingSlash(routerConfig.basename || '/'))
const sourceDir = projectConfig.sourceRoot || CONFIG.SOURCE_DIR
const sourcePath = path.join(appPath, sourceDir)
const outputDir = projectConfig.outputRoot || CONFIG.OUTPUT_DIR
const outputPath = path.join(appPath, outputDir)
const tempDir = CONFIG.TEMP_DIR
const tempPath = path.join(appPath, tempDir)
const entryFilePath = resolveScriptPath(path.join(sourcePath, CONFIG.ENTRY))
const entryFileName = path.basename(entryFilePath)
const pxTransformConfig = { designWidth: projectConfig.designWidth || 750 }
const pathAlias = projectConfig.alias || {}

const PACKAGES = {
  '@tarojs/taro': '@tarojs/taro',
  '@tarojs/taro-h5': '@tarojs/taro-h5',
  '@tarojs/redux': '@tarojs/redux',
  '@tarojs/redux-h5': '@tarojs/redux-h5',
  '@tarojs/mobx': '@tarojs/mobx',
  '@tarojs/mobx-h5': '@tarojs/mobx-h5',
  '@tarojs/router': `@tarojs/router`,
  '@tarojs/components': '@tarojs/components',
  'nervjs': 'nervjs',
  'nerv-redux': 'nerv-redux'
}

// const taroApis = [
//   'Component',
//   'PureComponent',
//   'getEnv',
//   'ENV_TYPE',
//   'eventCenter',
//   'Events',
//   'internal_safe_get',
//   'internal_dynamic_recursive'
// ]
const nervJsImportDefaultName = 'Nerv'
const tabBarComponentName = 'Tabbar'
const tabBarContainerComponentName = 'TabbarContainer'
const tabBarPanelComponentName = 'TabbarPanel'
const providerComponentName = 'Provider'
const setStoreFuncName = 'setStore'
const tabBarConfigName = '__tabs'
const DEVICE_RATIO = 'deviceRatio'

const MAP_FROM_COMPONENTNAME_TO_ID = new Map([
  ['Video', 'id'],
  ['Canvas', 'canvasId']
])
const APIS_NEED_TO_APPEND_THIS = new Map([
  ['createVideoContext', 1],
  ['createCanvasContext', 1],
  ['canvasGetImageData', 1],
  ['canvasPutImageData', 1],
  ['canvasToTempFilePath', 1]
])

if (projectConfig.hasOwnProperty(DEVICE_RATIO)) {
  pxTransformConfig[DEVICE_RATIO] = projectConfig.deviceRatio
}

let pages: string[] = []

const FILE_TYPE = {
  ENTRY: 'ENTRY',
  PAGE: 'PAGE',
  COMPONENT: 'COMPONENT',
  NORMAL: 'NORMAL'
}

const isUnderSubPackages = (parentPath) => (parentPath.isObjectProperty() && /subPackages|subpackages/i.test(toVar(parentPath.node.key)))

function createRoute ({ absPagename, relPagename, isIndex, chunkName = '' }) {
  const chunkNameComment = chunkName ? `/* webpackChunkName: "${chunkName}" */` : ''
  return `{
    path: '${absPagename}',
    componentLoader: () => import(${chunkNameComment}'${relPagename}'),
    isIndex: ${isIndex}
  }`
}

function classifyFiles (filename) {
  const relPath = path.normalize(
    path.relative(appPath, filename)
  )
  if (path.relative(filename, entryFilePath) === '') return FILE_TYPE.ENTRY

  let relSrcPath = path.relative('src', relPath)
  relSrcPath = path.format({
    dir: path.dirname(relSrcPath),
    base: path.basename(relSrcPath, path.extname(relSrcPath))
  })

  const isPage = pages.some(page => {
    const relPage = path.normalize(
      path.relative(appPath, page)
    )
    if (path.relative(relPage, relSrcPath) === '') return true
    return false
  })

  if (isPage) {
    return FILE_TYPE.PAGE
  } else {
    return FILE_TYPE.NORMAL
  }
}

function processEntry (code, filePath) {
  let ast = wxTransformer({
    code,
    sourcePath: filePath,
    isNormal: true,
    isTyped: REG_TYPESCRIPT.test(filePath),
    adapter: 'h5'
  }).ast
  let taroImportDefaultName
  let providorImportName
  let storeName
  let renderCallCode

  let tabBar
  let tabbarPos
  let hasConstructor = false
  let hasComponentWillMount = false
  let hasComponentDidMount = false
  let hasComponentDidShow = false
  let hasComponentDidHide = false
  let hasComponentWillUnmount = false
  let hasJSX = false
  let hasNerv = false
  let hasState = false

  const initPxTransformNode = toAst(`Taro.initPxTransform(${JSON.stringify(pxTransformConfig)})`)
  const additionalConstructorNode = toAst(`Taro._$app = this`)

  ast = babel.transformFromAst(ast, '', {
    plugins: [
      [require('babel-plugin-danger-remove-unused-import'), { ignore: ['@tarojs/taro', 'react', 'nervjs'] }]
    ]
  }).ast

  const ClassDeclarationOrExpression = {
    enter (astPath) {
      const node = astPath.node
      if (!node.superClass) return
      if (
        node.superClass.type === 'MemberExpression' &&
        node.superClass.object.name === taroImportDefaultName &&
        (node.superClass.property.name === 'Component' ||
        node.superClass.property.name === 'PureComponent')
      ) {
        node.superClass.object.name = taroImportDefaultName
        if (node.id === null) {
          const renameComponentClassName = '_TaroComponentClass'
          astPath.replaceWith(
            t.classExpression(
              t.identifier(renameComponentClassName),
              node.superClass,
              node.body,
              node.decorators || []
            )
          )
        }
      } else if (node.superClass.name === 'Component' ||
        node.superClass.name === 'PureComponent') {
        resetTSClassProperty(node.body.body)
        if (node.id === null) {
          const renameComponentClassName = '_TaroComponentClass'
          astPath.replaceWith(
            t.classExpression(
              t.identifier(renameComponentClassName),
              node.superClass,
              node.body,
              node.decorators || []
            )
          )
        }
      }
    }
  }

  /**
   * ProgramExit使用的visitor
   * 负责修改render函数的内容，在componentDidMount中增加componentDidShow调用，在componentWillUnmount中增加componentDidHide调用。
   */
  const programExitVisitor = {
    ClassMethod: {
      exit (astPath: NodePath<t.ClassMethod>) {
        const node = astPath.node
        const key = node.key
        const keyName = toVar(key)
        let funcBody

        const isRender = keyName === 'render'
        const isComponentWillMount = keyName === 'componentWillMount'
        const isComponentDidMount = keyName === 'componentDidMount'
        const isComponentWillUnmount = keyName === 'componentWillUnmount'
        const isConstructor = keyName === 'constructor'

        if (isRender) {
          const routes = pages.map((v, k) => {
            const absPagename = addLeadingSlash(v)
            const relPagename = `.${absPagename}`
            const chunkName = relPagename.split('/').filter(v => !/^(pages|\.)$/i.test(v)).join('_')
            return createRoute({
              absPagename,
              relPagename,
              chunkName,
              isIndex: k === 0
            })
          })

          funcBody = `
            <Router
              history={_taroHistory}
              routes={[${routes.join(',')}]}
              customRoutes={${JSON.stringify(customRoutes)}} />
            `

          /* 插入Tabbar */
          if (tabBar) {
            const homePage = pages[0] || ''
            if (tabbarPos === 'top') {
              funcBody = `
                <${tabBarContainerComponentName}>

                  <${tabBarComponentName}
                    conf={this.state.${tabBarConfigName}}
                    homePage="${homePage}"
                    tabbarPos={'top'} />

                  <${tabBarPanelComponentName}>
                    ${funcBody}
                  </${tabBarPanelComponentName}>

                </${tabBarContainerComponentName}>`
            } else {
              funcBody = `
                <${tabBarContainerComponentName}>

                  <${tabBarPanelComponentName}>
                    ${funcBody}
                  </${tabBarPanelComponentName}>

                  <${tabBarComponentName}
                    conf={this.state.${tabBarConfigName}}
                    homePage="${homePage}"
                    router={${taroImportDefaultName}} />

                </${tabBarContainerComponentName}>`
            }
          }

          /* 插入<Provider /> */
          if (providerComponentName && storeName) {
            // 使用redux 或 mobx
            funcBody = `
              <${providorImportName} store={${storeName}}>
                ${funcBody}
              </${providorImportName}>`
          }

          /* 插入<Router /> */
          node.body = toAst(`{return (${funcBody});}`, { preserveComments: true })
        }

        if (tabBar && isComponentWillMount) {
          const initTabBarApisCallNode = toAst(`Taro.initTabBarApis(this, Taro)`)
          node.body.body.push(initTabBarApisCallNode)
        }

        if (hasConstructor && isConstructor) {
          node.body.body.push(additionalConstructorNode)
        }

        if (hasComponentDidShow && isComponentDidMount) {
          const componentDidShowCallNode = toAst(`this.componentDidShow()`)
          node.body.body.push(componentDidShowCallNode)
        }

        if (hasComponentDidHide && isComponentWillUnmount) {
          const componentDidHideCallNode = toAst(`this.componentDidHide()`)
          node.body.body.unshift(componentDidHideCallNode)
        }
      }
    },
    ClassProperty: {
      exit (astPath: NodePath<t.ClassProperty>) {
        const node = astPath.node
        const key = node.key
        const value = node.value
        if (key.name !== 'state' || !t.isObjectExpression(value)) return
        value.properties.push(t.objectProperty(
          t.identifier(tabBarConfigName),
          tabBar
        ))
      }
    },
    ClassBody: {
      exit (astPath: NodePath<t.ClassBody>) {
        const node = astPath.node
        if (hasComponentDidShow && !hasComponentDidMount) {
          node.body.push(t.classMethod(
            'method', t.identifier('componentDidMount'), [],
            t.blockStatement([
              toAst('super.componentDidMount && super.componentDidMount()') as t.Statement
            ]), false, false))
        }
        if (hasComponentDidHide && !hasComponentWillUnmount) {
          node.body.push(t.classMethod(
            'method', t.identifier('componentWillUnmount'), [],
            t.blockStatement([
              toAst('super.componentWillUnmount && super.componentWillUnmount()') as t.Statement
            ]), false, false))
        }
        if (!hasConstructor) {
          node.body.push(t.classMethod(
            'method', t.identifier('constructor'), [t.identifier('props'), t.identifier('context')],
            t.blockStatement([toAst('super(props, context)'), additionalConstructorNode] as any), false, false))
        }
        if (tabBar) {
          if (!hasComponentWillMount) {
            node.body.push(t.classMethod(
              'method', t.identifier('componentWillMount'), [],
              t.blockStatement([
                toAst('super.componentWillMount && super.componentWillMount()') as t.Statement
              ]), false, false))
          }
          if (!hasState) {
            node.body.unshift(t.classProperty(
              t.identifier('state'),
              t.objectExpression([])
            ))
          }
        }
      }
    }
  }

  /**
   * ClassProperty使用的visitor
   * 负责收集config中的pages，收集tabbar的position，替换icon。
   */
  const classPropertyVisitor = {
    ObjectProperty (astPath: NodePath<t.ObjectProperty>) {
      const node = astPath.node
      const key = node.key
      const value = node.value
      const keyName = toVar(key)
      if (keyName === 'pages' && t.isArrayExpression(value)) {
        const subPackageParent = astPath.findParent(isUnderSubPackages)
        let root = ''
        if (subPackageParent) {
          /* 在subPackages属性下，说明是分包页面，需要处理root属性 */
          const parent = astPath.parent as t.ObjectExpression
          const rootNode = parent.properties.find(v => {
            if (t.isSpreadProperty(v)) return false
            return toVar(v.key) === 'root'
          }) as t.ObjectProperty
          root = rootNode ? toVar(rootNode.value) : ''
        }
        (value.elements as t.StringLiteral[]).forEach(v => {
          const pagePath = `${root}/${v.value}`.replace(/\/{2,}/g, '/')
          pages.push(removeLeadingSlash(pagePath))
          v.value = addLeadingSlash(v.value)
        })
      } else if (keyName === 'tabBar' && t.isObjectExpression(value)) {
        // tabBar相关处理
        tabBar = value
        value.properties.forEach((node) => {
          if (t.isSpreadProperty(node)) return
          switch (toVar(node.key)) {
            case 'position':
              tabbarPos = toVar(node.value)
              break
            case 'list':
              t.isArrayExpression(node.value) && node.value.elements.forEach(v => {
                if (!t.isObjectExpression(v)) return
                v.properties.forEach(property => {
                  if (!t.isObjectProperty(property)) return
                  switch (toVar(property.key)) {
                    case 'iconPath':
                    case 'selectedIconPath':
                      if (t.isStringLiteral(property.value)) {
                        property.value = t.callExpression(
                          t.identifier('require'),
                          [t.stringLiteral(`./${property.value.value}`)]
                        )
                      }
                      break
                    case 'pagePath':
                      property.value = t.stringLiteral(addLeadingSlash(toVar(property.value)))
                      break
                  }
                })
              })
          }
        })
        value.properties.push(t.objectProperty(
          t.identifier('mode'),
          t.stringLiteral(routerMode)
        ))
        value.properties.push(t.objectProperty(
          t.identifier('basename'),
          t.stringLiteral(routerBasename)
        ))
        value.properties.push(t.objectProperty(
          t.identifier('customRoutes'),
          t.objectExpression(objToAst(customRoutes))
        ))
      }
    }
  }

  traverse(ast, {
    ClassExpression: ClassDeclarationOrExpression,
    ClassDeclaration: ClassDeclarationOrExpression,
    ClassProperty: {
      enter (astPath: NodePath<t.ClassProperty>) {
        const node = astPath.node
        const key = node.key
        const keyName = toVar(key)

        if (keyName === 'state') {
          hasState = true
        } else if (keyName === 'config') {
          // appConfig = toVar(node.value)
          astPath.traverse(classPropertyVisitor)
        }
      }
    },
    ImportDeclaration: {
      enter (astPath: NodePath<t.ImportDeclaration>) {
        const node = astPath.node
        const source = node.source
        const specifiers = node.specifiers
        let value = source.value
        if (isAliasPath(value, pathAlias)) {
          source.value = value = replaceAliasPath(filePath, value, pathAlias)
        }
        if (!isNpmPkg(value)) {
          if (value.indexOf('.') === 0) {
            const pathArr = value.split('/')
            if (pathArr.indexOf('pages') >= 0) {
              astPath.remove()
            } else if (REG_SCRIPTS.test(value) || path.extname(value) === '') {
              const absolutePath = path.resolve(filePath, '..', value)
              const dirname = path.dirname(absolutePath)
              const extname = path.extname(absolutePath)
              const realFilePath = resolveScriptPath(path.join(dirname, path.basename(absolutePath, extname)))
              const removeExtPath = realFilePath.replace(path.extname(realFilePath), '')
              node.source = t.stringLiteral(promoteRelativePath(path.relative(filePath, removeExtPath)).replace(/\\/g, '/'))
            }
          }
          return
        }
        if (value === PACKAGES['@tarojs/taro']) {
          source.value = PACKAGES['@tarojs/taro-h5']
          const specifier = specifiers.find(item => t.isImportDefaultSpecifier(item))
          if (specifier) {
            taroImportDefaultName = toVar(specifier.local)
          }
        } else if (value === PACKAGES['@tarojs/redux']) {
          const specifier = specifiers.find(item => {
            return t.isImportSpecifier(item) && item.imported.name === providerComponentName
          })
          if (specifier) {
            providorImportName = specifier.local.name
          } else {
            providorImportName = providerComponentName
            specifiers.push(t.importSpecifier(t.identifier(providerComponentName), t.identifier(providerComponentName)))
          }
          source.value = PACKAGES['@tarojs/redux-h5']
        } else if (value === PACKAGES['@tarojs/mobx']) {
          const specifier = specifiers.find(item => {
            return t.isImportSpecifier(item) && item.imported.name === providerComponentName
          })
          if (specifier) {
            providorImportName = specifier.local.name
          } else {
            providorImportName = providerComponentName
            specifiers.push(t.importSpecifier(t.identifier(providerComponentName), t.identifier(providerComponentName)))
          }
          source.value = PACKAGES['@tarojs/mobx-h5']
        } else if (value === PACKAGES['nervjs']) {
          hasNerv = true
          const defaultSpecifier = specifiers.find(item => t.isImportDefaultSpecifier(item))
          if (!defaultSpecifier) {
            specifiers.unshift(
              t.importDefaultSpecifier(t.identifier(nervJsImportDefaultName))
            )
          }
        }
      }
    },
    CallExpression: {
      enter (astPath: NodePath<t.CallExpression>) {
        const node = astPath.node
        const callee = node.callee
        const calleeName = toVar(callee)
        const parentPath = astPath.parentPath

        if (t.isMemberExpression(callee)) {
          const object = callee.object as t.Identifier
          const property = callee.property as t.Identifier
          if (object.name === taroImportDefaultName && property.name === 'render') {
            object.name = nervJsImportDefaultName
            renderCallCode = generate(astPath.node).code
            astPath.remove()
          }
        } else {
          if (calleeName === setStoreFuncName) {
            if (parentPath.isAssignmentExpression() ||
              parentPath.isExpressionStatement() ||
              parentPath.isVariableDeclarator()) {
              parentPath.remove()
            }
          }
        }
      }
    },
    ClassMethod: {
      exit (astPath: NodePath<t.ClassMethod>) {
        const node = astPath.node
        const key = node.key
        const keyName = toVar(key)
        if (keyName === 'constructor') {
          hasConstructor = true
        } else if (keyName === 'componentWillMount') {
          hasComponentWillMount = true
        } else if (keyName === 'componentDidMount') {
          hasComponentDidMount = true
        } else if (keyName === 'componentDidShow') {
          hasComponentDidShow = true
        } else if (keyName === 'componentDidHide') {
          hasComponentDidHide = true
        } else if (keyName === 'componentWillUnmount') {
          hasComponentWillUnmount = true
        }
      }
    },
    JSXElement: {
      enter (astPath) {
        hasJSX = true
      }
    },
    JSXOpeningElement: {
      enter (astPath: NodePath<t.JSXOpeningElement>) {
        const node = astPath.node
        if (toVar(node.name) === 'Provider') {
          for (const v of node.attributes) {
            if (v.name.name !== 'store') continue
            if (!t.isJSXExpressionContainer(v.value)) return
            storeName = toVar(v.value.expression)
            break
          }
        }
      }
    },
    Program: {
      exit (astPath: NodePath<t.Program>) {
        const node = astPath.node
        const importRouterNode = toAst(`import { Router, createHistory, mountApis } from '${PACKAGES['@tarojs/router']}'`)
        const importComponentNode = toAst(`import { View, ${tabBarComponentName}, ${tabBarContainerComponentName}, ${tabBarPanelComponentName}} from '${PACKAGES['@tarojs/components']}'`)
        const lastImportIndex = _.findLastIndex(astPath.node.body, t.isImportDeclaration)
        const lastImportNode = astPath.get(`body.${lastImportIndex > -1 ? lastImportIndex : 0}`) as NodePath<babel.types.Node>
        const createHistoryNode = toAst(`
          const _taroHistory = createHistory({
            mode: "${routerMode}",
            basename: "${routerBasename}",
            customRoutes: ${JSON.stringify(customRoutes)},
            firstPagePath: "${addLeadingSlash(pages[0])}"
          });
        `)
        const mountApisNode = toAst(`mountApis(_taroHistory);`)
        const extraNodes = [
          importRouterNode,
          initPxTransformNode,
          createHistoryNode,
          mountApisNode
        ]

        astPath.traverse(programExitVisitor)

        if (hasJSX && !hasNerv) {
          extraNodes.unshift(
            t.importDeclaration(
              [t.importDefaultSpecifier(t.identifier(nervJsImportDefaultName))],
              t.stringLiteral(PACKAGES['nervjs'])
            )
          )
        }
        if (tabBar) {
          extraNodes.unshift(importComponentNode)
        }

        lastImportNode.insertAfter(extraNodes)
        if (renderCallCode) {
          const renderCallNode = toAst(renderCallCode)
          node.body.push(renderCallNode)
        }
      }
    }
  })
  const generateCode = generate(ast, {
    jsescOption: {
      minimal: true
    }
  }).code
  return {
    code: generateCode,
    ast
  }
}

function processOthers (code, filePath, fileType) {
  const componentnameMap = new Map()
  const taroapiMap = new Map()
  const isPage = fileType === FILE_TYPE.PAGE
  let ast = wxTransformer({
    code,
    sourcePath: filePath,
    isNormal: true,
    isTyped: REG_TYPESCRIPT.test(filePath),
    adapter: 'h5'
  }).ast
  let taroImportDefaultName
  let hasJSX = false
  let hasNerv = false
  let hasComponentDidMount = false
  let hasComponentDidShow = false
  let hasComponentDidHide = false
  let hasOnPageScroll = false
  let hasOnReachBottom = false
  let hasOnPullDownRefresh = false
  let pageConfig: PageConfig = {}

  ast = babel.transformFromAst(ast, '', {
    plugins: [
      [require('babel-plugin-danger-remove-unused-import'), { ignore: ['@tarojs/taro', 'react', 'nervjs'] }]
    ]
  }).ast

  const ClassDeclarationOrExpression = {
    enter (astPath) {
      const node = astPath.node
      if (!node.superClass) return
      if (
        node.superClass.type === 'MemberExpression' &&
        node.superClass.object.name === taroImportDefaultName &&
        (node.superClass.property.name === 'Component' ||
        node.superClass.property.name === 'PureComponent')
      ) {
        node.superClass.object.name = taroImportDefaultName
        if (node.id === null) {
          const renameComponentClassName = '_TaroComponentClass'
          astPath.replaceWith(
            t.classExpression(
              t.identifier(renameComponentClassName),
              node.superClass,
              node.body,
              node.decorators || []
            )
          )
        }
      } else if (node.superClass.name === 'Component' ||
        node.superClass.name === 'PureComponent') {
        resetTSClassProperty(node.body.body)
        if (node.id === null) {
          const renameComponentClassName = '_TaroComponentClass'
          astPath.replaceWith(
            t.classExpression(
              t.identifier(renameComponentClassName),
              node.superClass,
              node.body,
              node.decorators || []
            )
          )
        }
      }
    }
  }

  const programExitVisitor = {
    ImportDeclaration: {
      exit (astPath) {
        const node = astPath.node
        const specifiers = node.specifiers
        if (toVar(node.source) !== PACKAGES['@tarojs/components']) return
        if (hasOnPullDownRefresh) {
          const pos = specifiers.findIndex(specifier => {
            if (!specifier.imported) return false
            const importedComponent = toVar(specifier.imported)
            return importedComponent === 'PullDownRefresh'
          })
          if (pos === -1) {
            specifiers.push(
              t.importSpecifier(
                t.identifier('PullDownRefresh'),
                t.identifier('PullDownRefresh')
              )
            )
          }
        }
      }
    },
    ClassBody: {
      exit (astPath) {
        if (!hasComponentDidMount) {
          astPath.pushContainer('body', t.classMethod(
            'method', t.identifier('componentDidMount'), [],
            t.blockStatement([
              toAst('super.componentDidMount && super.componentDidMount()') as t.Statement
            ]), false, false))
        }
        if (!hasComponentDidShow) {
          astPath.pushContainer('body', t.classMethod(
            'method', t.identifier('componentDidShow'), [],
            t.blockStatement([
              toAst('super.componentDidShow && super.componentDidShow()') as t.Statement
            ]), false, false))
        }
        if (!hasComponentDidHide) {
          astPath.pushContainer('body', t.classMethod(
            'method', t.identifier('componentDidHide'), [],
            t.blockStatement([
              toAst('super.componentDidHide && super.componentDidHide()') as t.Statement
            ]), false, false))
        }
      }
    },
    ClassMethod: {
      exit (astPath) {
        const node = astPath.node
        const key = node.key
        const keyName = toVar(key)
        if (hasOnReachBottom) {
          if (keyName === 'componentDidShow') {
            node.body.body.push(
              toAst(`
                this._offReachBottom = Taro.onReachBottom({
                  callback: this.onReachBottom,
                  ctx: this,
                  onReachBottomDistance: ${JSON.stringify(pageConfig.onReachBottomDistance)}
                })
              `)
            )
          } else if (keyName === 'componentDidHide') {
            node.body.body.push(
              toAst('this._offReachBottom && this._offReachBottom()')
            )
          }
        }
        if (hasOnPageScroll) {
          if (keyName === 'componentDidShow') {
            node.body.body.push(
              toAst('this._offPageScroll = Taro.onPageScroll({ callback: this.onPageScroll, ctx: this })')
            )
          } else if (keyName === 'componentDidHide') {
            node.body.body.push(
              toAst('this._offPageScroll && this._offPageScroll()')
            )
          }
        }
        if (hasOnPullDownRefresh) {
          if (keyName === 'componentDidShow') {
            node.body.body.push(
              toAst(`
                this.pullDownRefreshRef && this.pullDownRefreshRef.bindEvent()
              `)
            )
          }
          if (keyName === 'componentDidHide') {
            node.body.body.push(
              toAst(`
                this.pullDownRefreshRef && this.pullDownRefreshRef.unbindEvent()
              `)
            )
          }
          if (keyName === 'render') {
            astPath.traverse({
              ReturnStatement: {
                exit (returnAstPath) {
                  const statement = returnAstPath.node
                  const varName = returnAstPath.scope.generateUid()
                  const returnValue = statement.argument
                  const pullDownRefreshNode = t.variableDeclaration(
                    'const',
                    [t.variableDeclarator(
                      t.identifier(varName),
                      returnValue
                    )]
                  )
                  returnAstPath.insertBefore(pullDownRefreshNode)
                  statement.argument = (toAst(`
                    <PullDownRefresh
                      onRefresh={this.onPullDownRefresh && this.onPullDownRefresh.bind(this)}
                      ref={ref => {
                        if (ref) this.pullDownRefreshRef = ref
                    }}>{${varName}}</PullDownRefresh>`) as t.ExpressionStatement).expression
                }
              }
            })
          }
        }
      }
    }
  }

  const getComponentId = (componentName, node) => {
    const idAttrName = MAP_FROM_COMPONENTNAME_TO_ID.get(componentName)
    return node.attributes.reduce((prev, attribute) => {
      if (prev) return prev
      const attrName = toVar(attribute.name)
      if (attrName === idAttrName) return toVar(attribute.value)
      else return false
    }, false)
  }
  const getComponentRef = node => {
    return node.attributes.find(attribute => {
      return toVar(attribute.name) === 'ref'
    })
  }
  const createRefFunc = componentId => {
    return t.arrowFunctionExpression(
      [t.identifier('ref')],
      t.blockStatement([
        toAst(`this['__taroref_${componentId}'] = ref`) as t.Statement
      ])
    )
  }

  traverse(ast, {
    ClassExpression: ClassDeclarationOrExpression,
    ClassDeclaration: ClassDeclarationOrExpression,
    ClassProperty: isPage ? {
      enter (astPath: any) {
        const node = astPath.node
        const key = toVar(node.key)
        if (key === 'config') {
          pageConfig = toVar(node.value)
        }
      }
    } : {},
    ClassMethod: isPage ? {
      exit (astPath) {
        const node = astPath.node as t.ClassMethod
        const key = node.key
        const keyName = toVar(key)
        if (keyName === 'componentDidMount') {
          hasComponentDidMount = true
        } else if (keyName === 'componentDidShow') {
          hasComponentDidShow = true
        } else if (keyName === 'componentDidHide') {
          hasComponentDidHide = true
        } else if (keyName === 'onPageScroll') {
          hasOnPageScroll = true
        } else if (keyName === 'onReachBottom') {
          hasOnReachBottom = true
        } else if (keyName === 'onPullDownRefresh') {
          hasOnPullDownRefresh = true
        }
      }
    } : {},
    ImportDeclaration: {
      enter (astPath) {
        const node = astPath.node as t.ImportDeclaration
        const source = node.source
        let value = source.value
        const specifiers = node.specifiers
        if (isAliasPath(value, pathAlias)) {
          source.value = value = replaceAliasPath(filePath, value, pathAlias)
        }
        if (!isNpmPkg(value)) {
          if (REG_SCRIPTS.test(value) || path.extname(value) === '') {
            const absolutePath = path.resolve(filePath, '..', value)
            const dirname = path.dirname(absolutePath)
            const extname = path.extname(absolutePath)
            const realFilePath = resolveScriptPath(path.join(dirname, path.basename(absolutePath, extname)))
            const removeExtPath = realFilePath.replace(path.extname(realFilePath), '')
            node.source = t.stringLiteral(promoteRelativePath(path.relative(filePath, removeExtPath)).replace(/\\/g, '/'))
          }
        } else if (value === PACKAGES['@tarojs/taro']) {
          source.value = PACKAGES['@tarojs/taro-h5']
          specifiers.forEach(specifier => {
            if (t.isImportDefaultSpecifier(specifier)) {
              taroImportDefaultName = toVar(specifier.local)
            } else if (t.isImportSpecifier(specifier)) {
              taroapiMap.set(toVar(specifier.local), toVar(specifier.imported))
            }
          })
        } else if (value === PACKAGES['@tarojs/redux']) {
          source.value = PACKAGES['@tarojs/redux-h5']
        } else if (value === PACKAGES['@tarojs/mobx']) {
          source.value = PACKAGES['@tarojs/mobx-h5']
        } else if (value === PACKAGES['@tarojs/components']) {
          node.specifiers.forEach((specifier: any) => {
            if (t.isImportDefaultSpecifier(specifier)) return
            componentnameMap.set(toVar(specifier.local), toVar(specifier.imported))
          })
        } else if (value === PACKAGES['nervjs']) {
          hasNerv = true
          const defaultSpecifier = specifiers.find(item => t.isImportDefaultSpecifier(item))
          if (!defaultSpecifier) {
            specifiers.unshift(
              t.importDefaultSpecifier(t.identifier(nervJsImportDefaultName))
            )
          }
        }
      }
    },
    JSXOpeningElement: {
      exit (astPath: any) {
        hasJSX = true
        const node = astPath.node
        const componentName = componentnameMap.get(toVar(node.name))
        const componentId = getComponentId(componentName, node)
        const componentRef = getComponentRef(node)

        if (!componentId) return
        const refFunc = createRefFunc(componentId) as any

        if (componentRef) {
          const expression = componentRef.value.expression
          refFunc.body.body.unshift(
            t.callExpression(expression, [t.identifier('ref')])
          )
          componentRef.value.expression = refFunc
        } else {
          node.attributes.push(
            t.jSXAttribute(
              t.jSXIdentifier('ref'),
              t.jSXExpressionContainer(refFunc)
            )
          )
        }
      }
    },
    CallExpression: {
      exit (astPath: any) {
        const node = astPath.node
        const callee = node.callee
        let needToAppendThis = false
        let funcName = ''
        if (t.isMemberExpression(callee)) {
          const objName = toVar(callee.object)
          const tmpFuncName = toVar(callee.property)
          if (objName === taroImportDefaultName && APIS_NEED_TO_APPEND_THIS.has(tmpFuncName)) {
            needToAppendThis = true
            funcName = tmpFuncName
          }
        } else if (t.isIdentifier(callee)) {
          const tmpFuncName = toVar(callee)
          const oriFuncName = taroapiMap.get(tmpFuncName)
          if (APIS_NEED_TO_APPEND_THIS.has(oriFuncName)) {
            needToAppendThis = true
            funcName = oriFuncName
          }
        }
        if (needToAppendThis) {
          const thisOrder = APIS_NEED_TO_APPEND_THIS.get(funcName)
          if (thisOrder && !node.arguments[thisOrder]) {
            node.arguments[thisOrder] = t.thisExpression()
          }
        }
      }
    },
    Program: {
      exit (astPath: any) {
        if (isPage) {
          astPath.traverse(programExitVisitor)
        }
        const node = astPath.node
        if (hasJSX && !hasNerv) {
          node.body.unshift(
            t.importDeclaration(
              [t.importDefaultSpecifier(t.identifier(nervJsImportDefaultName))],
              t.stringLiteral(PACKAGES['nervjs'])
            )
          )
        }
      }
    }
  })
  const generateCode = generate(ast, {
    jsescOption: {
      minimal: true
    }
  }).code
  return {
    code: generateCode,
    ast
  }
}

/**
 * TS 编译器会把 class property 移到构造器，
 * 而小程序要求 `config` 和所有函数在初始化(after new Class)之后就收集到所有的函数和 config 信息，
 * 所以当如构造器里有 this.func = () => {...} 的形式，就给他转换成普通的 classProperty function
 * 如果有 config 就给他还原
 */
function resetTSClassProperty (body) {
  for (const method of body) {
    if (t.isClassMethod(method) && method.kind === 'constructor') {
      for (const statement of _.cloneDeep(method.body.body)) {
        if (t.isExpressionStatement(statement) && t.isAssignmentExpression(statement.expression)) {
          const expr = statement.expression
          const { left, right } = expr
          if (
            t.isMemberExpression(left) &&
              t.isThisExpression(left.object) &&
              t.isIdentifier(left.property)
          ) {
            if (
              (t.isArrowFunctionExpression(right) || t.isFunctionExpression(right)) ||
                (left.property.name === 'config' && t.isObjectExpression(right))
            ) {
              body.push(
                t.classProperty(left.property, right)
              )
              _.remove(method.body.body, statement)
            }
          }
        }
      }
    }
  }
}

function getDist (filename, isScriptFile) {
  const dirname = path.dirname(filename)
  const distDirname = dirname.replace(sourcePath, tempDir)
  return isScriptFile
    ? path.format({
      dir: distDirname,
      ext: '.js',
      name: path.basename(filename, path.extname(filename))
    })
    : path.format({
      dir: distDirname,
      base: path.basename(filename)
    })
}

export function processFiles (filePath) {
  const file = fs.readFileSync(filePath)
  const dirname = path.dirname(filePath)
  const extname = path.extname(filePath)
  const distDirname = dirname.replace(sourcePath, tempDir)
  const isScriptFile = REG_SCRIPTS.test(extname)
  const distPath = getDist(filePath, isScriptFile)

  try {
    if (isScriptFile) {
      // 脚本文件 处理一下
      const fileType = classifyFiles(filePath)
      const content = file.toString()
      let transformResult
      if (fileType === FILE_TYPE.ENTRY) {
        pages = []
        transformResult = processEntry(content, filePath)
      } else {
        transformResult = processOthers(content, filePath, fileType)
      }
      const jsCode = transformResult.code
      fs.ensureDirSync(distDirname)
      fs.writeFileSync(distPath, Buffer.from(jsCode))
    } else {
      // 其他 直接复制
      fs.ensureDirSync(distDirname)
      fs.copySync(filePath, distPath)
    }
  } catch (e) {
    console.log(e)
  }
}

function watchFiles () {
  const watcher = chokidar.watch(path.join(sourcePath), {
    ignored: /(^|[/\\])\../,
    persistent: true,
    ignoreInitial: true
  })
  watcher
    .on('add', filePath => {
      const relativePath = path.relative(appPath, filePath)
      printLog(processTypeEnum.CREATE, '添加文件', relativePath)
      processFiles(filePath)
    })
    .on('change', filePath => {
      const relativePath = path.relative(appPath, filePath)
      printLog(processTypeEnum.MODIFY, '文件变动', relativePath)
      processFiles(filePath)
    })
    .on('unlink', filePath => {
      const relativePath = path.relative(appPath, filePath)
      const extname = path.extname(relativePath)
      const isScriptFile = REG_SCRIPTS.test(extname)
      const dist = getDist(filePath, isScriptFile)
      printLog(processTypeEnum.UNLINK, '删除文件', relativePath)
      fs.unlinkSync(dist)
    })
}

export function buildTemp () {
  fs.ensureDirSync(tempPath)
  return new Promise((resolve, reject) => {
    klaw(sourcePath)
      .on('data', file => {
        const relativePath = path.relative(appPath, file.path)
        if (!file.stats.isDirectory()) {
          printLog(processTypeEnum.CREATE, '发现文件', relativePath)
          processFiles(file.path)
        }
      })
      .on('end', () => {
        resolve()
      })
  })
}

async function buildDist (buildConfig: IBuildConfig) {
  const { watch } = buildConfig
  const entryFile = path.basename(entryFileName, path.extname(entryFileName)) + '.js'
  const sourceRoot = projectConfig.sourceRoot || CONFIG.SOURCE_DIR
  if (projectConfig.deviceRatio) {
    h5Config.deviceRatio = projectConfig.deviceRatio
  }
  if (projectConfig.env) {
    h5Config.env = projectConfig.env
  }
  recursiveMerge(h5Config, {
    defineConstants: projectConfig.defineConstants,
    designWidth: projectConfig.designWidth,
    entry: {
      app: [path.join(tempPath, entryFile)]
    },
    env: {
      TARO_ENV: JSON.stringify(BUILD_TYPES.H5)
    },
    isWatch: !!watch,
    outputRoot: outputDir,
    plugins: projectConfig.plugins,
    port: buildConfig.port,
    sourceRoot: sourceRoot
  })

  const webpackRunner = await npmProcess.getNpmPkg('@tarojs/webpack-runner')
  webpackRunner(h5Config)
}

const pRimraf = promisify(rimraf)

async function clean () {
  try {
    await pRimraf(tempPath)
    await pRimraf(outputPath)
  } catch (e) {
    console.log(e)
  }
}

export async function build (buildConfig: IBuildConfig) {
  process.env.TARO_ENV = BUILD_TYPES.H5
  await clean()
  copyFiles(appPath, projectConfig.copy)
  await buildTemp()
  await buildDist(buildConfig)
  if (buildConfig.watch) {
    watchFiles()
  }
}
