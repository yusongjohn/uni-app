const t = require('@babel/types')
const template = require('@babel/template').default

const {
  METHOD_BUILT_IN,
  METHOD_CREATE_EMPTY_VNODE,
  METHOD_CREATE_ELEMENT,
  METHOD_RENDER_LIST
} = require('../../constants')

function needSlotMode (path, ids) {
  let need
  path.traverse({
    noScope: false,
    Property (path) {
      // 跳过事件
      if (path.node.key.name === 'on') {
        const parentPath = path.parentPath.parentPath
        if (t.isCallExpression(parentPath) && parentPath.node.callee.name === METHOD_CREATE_ELEMENT) {
          path.skip()
        }
      }
    },
    Identifier (path) {
      const name = path.node.name
      if (path.key !== 'key' && (path.key !== 'property' || path.parent.computed)) {
        // 使用作用域内方法或作用域外数据
        if (name in ids) {
          need = path.key === 'callee' ? true : need
        } else if (!path.scope.hasBinding(name) && !METHOD_BUILT_IN.includes(name)) {
          need = true
        }
      } else if (path.key === 'property' && name === 'length') {
        // 微信小程序平台无法观测 Array length 访问：https://developers.weixin.qq.com/community/develop/doc/000c8ee47d87a0d5b6685a8cb57000
        need = true
      }
    }
  })
  return need
}

function replaceId (path, ids) {
  let replaced
  const fnPath = path.parentPath
  path.traverse({
    noScope: false,
    Identifier (path) {
      const name = path.node.name
      if (name in ids && fnPath.scope.bindings[name].referencePaths.find(refPath => refPath === path)) {
        path.replaceWith(t.cloneNode(ids[name], true))
        replaced = true
      }
    }
  })
  return replaced
}

module.exports = function getResolveScopedSlots (parent, state) {
  const elements0 = parent.get('arguments.0.elements.0')
  let objectPath = elements0
  // TODO v-else
  if (objectPath.isConditionalExpression()) {
    objectPath = objectPath.get('consequent')
  }
  if (objectPath.isCallExpression()) {
    objectPath = objectPath.get('arguments.1.body.body.0.argument')
  }
  const properties = objectPath.get('properties')
  const fn = properties.find(path => path.get('key').isIdentifier({ name: 'fn' }))
  const params = fn.get('value.params.0')
  if (!params) {
    return
  }
  const vueId = parent.parentPath.parentPath.get('properties').find(path => path.get('key').isIdentifier({ name: 'attrs' })).get('value').get('properties').find(path => path.get('key').isStringLiteral({ value: 'vue-id' })).get('value').node
  // TODO 多层 v-for 嵌套时，后续处理作用域可能发生变化，需安全重命名
  const slotPath = properties.find(path => path.get('key').isIdentifier({ name: 'key' })).get('value')
  const slotNode = slotPath.node
  const slotMultipleInstance = state.options.scopedSlotsCompiler === 'augmented' && state.options.slotMultipleInstance
  const scopedSlotsParams = {
    item: elements0.scope.generateUidIdentifier('item'),
    index: elements0.scope.generateUidIdentifier('index')
  }
  const ids = {}
  function updateIds (vueId, slot, value, key) {
    let node = slotMultipleInstance ? scopedSlotsParams.item : t.callExpression(t.identifier('$getSSP'), [vueId, slot])
    if (key) {
      node = t.memberExpression(node, t.stringLiteral(key), true)
    }
    ids[value] = node
  }
  if (params.isObjectPattern()) {
    params.get('properties').forEach(prop => {
      updateIds(vueId, slotNode, prop.get('value').node.name, prop.get('key').node.name)
    })
  } else if (params.isIdentifier()) {
    updateIds(vueId, slotNode, params.node.name)
  }
  const fnBody = fn.get('value.body')
  // 暂不处理旧版编译模式对于动态 slotName 的处理，含有动态 slotName 的情况下，scopedSlotsCompiler 指定使用新版编译模式
  const isStaticSlotName = t.isStringLiteral(slotNode)
  if (state.options.scopedSlotsCompiler === 'augmented' || needSlotMode(fnBody, ids) || !isStaticSlotName) {
    if (replaceId(fnBody, ids)) {
      const test = t.callExpression(t.identifier('$hasSSP'), [vueId])
      // scopedSlotsCompiler auto
      objectPath.node.scopedSlotsCompiler = 'augmented'
      if (slotMultipleInstance) {
        // elements0 节点替换增加一层循环
        let node = elements0.node
        const builder = template(`${METHOD_RENDER_LIST}($getSSP(%%vueId%%, %%slot%%, true), function (%%item%%, %%index%%) {return %%node%%})`)
        node = builder({
          vueId,
          slot: slotNode,
          node,
          item: scopedSlotsParams.item,
          index: scopedSlotsParams.index
        }).expression
        node = t.conditionalExpression(test, node, t.callExpression(t.identifier(METHOD_CREATE_EMPTY_VNODE), []))
        elements0.replaceWith(node)
        // 插槽名拼接 '.'+index
        slotPath.replaceWith(t.binaryExpression('+', slotNode, t.binaryExpression('+', t.stringLiteral('.'), scopedSlotsParams.index)))
      } else {
        const orgin = fnBody.get('body.0.argument')
        const elements = orgin.get('elements')
        const node = (elements.length === 1 ? elements[0] : orgin).node
        orgin.replaceWith(t.arrayExpression([t.conditionalExpression(test, node, t.callExpression(t.identifier(METHOD_CREATE_EMPTY_VNODE), []))]))
      }
    }
  }
}
