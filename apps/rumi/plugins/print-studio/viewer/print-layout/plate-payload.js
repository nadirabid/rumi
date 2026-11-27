/** Binary print-mesh records shared by the renderer and host. */
import { STL_LIMITS } from '../stl.js'

/** One little-endian record holds nine float32 coordinates and a uint32 sRGB color. */
export const PRINT_FACE_BYTES = 40

/** Bounds the binary meshes and multipart text before parsing. */
export const MAX_PRINT_PLATE_BYTES = STL_LIMITS.maxBytes
