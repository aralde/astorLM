import type { Tool } from '../types.js'
import { bashTool } from './builtin/bash.js'
import { editTool } from './builtin/edit.js'
import { globTool } from './builtin/glob.js'
import { grepTool } from './builtin/grep.js'
import { lsTool } from './builtin/ls.js'
import { readTool } from './builtin/read.js'
import { writeTool } from './builtin/write.js'

export { defineTool } from './define.js'
export { ToolRegistry } from './registry.js'

export function createCodingTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool, lsTool, grepTool, globTool] as Tool[]
}

export function createReadOnlyTools(): Tool[] {
  return [readTool, lsTool, grepTool, globTool] as Tool[]
}

export { readTool, writeTool, editTool, bashTool, lsTool, grepTool, globTool }
