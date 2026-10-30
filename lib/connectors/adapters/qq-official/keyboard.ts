/** Reviewed QQ keyboard wire shape; arbitrary card fields never reach the API. */
export class QQKeyboardValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QQKeyboardValidationError"
  }
}

export interface QQKeyboardButton {
  id: string
  group_id?: string
  render_data: { label: string; visited_label?: string; style?: number }
  action: {
    type: 0 | 1 | 2
    data: string
    permission: { type: 0 | 1 | 2; specify_user_ids?: string[] }
    unsupport_tips?: string
    enter?: boolean
    reply?: boolean
    anchor?: 1
    modal?: { content: string; confirm_text?: string; cancel_text?: string }
  }
}

export interface QQKeyboard {
  id?: string
  content?: { rows: { buttons: QQKeyboardButton[] }[] }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new QQKeyboardValidationError("QQ keyboard requires an object")
  return value as Record<string, unknown>
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new QQKeyboardValidationError("QQ keyboard contains invalid text")
  return value
}

/** Adapter bounds are deliberately conservative: five rows, five buttons per row. */
export function validateQQKeyboard(value: unknown, scene: "group" | "c2c"): QQKeyboard {
  const keyboard = object(value)
  if (keyboard.id !== undefined) {
    if (keyboard.content !== undefined)
      throw new QQKeyboardValidationError("QQ keyboard id and content are exclusive")
    return { id: text(keyboard.id, 256) }
  }
  const rows = object(keyboard.content).rows
  if (!Array.isArray(rows) || !rows.length || rows.length > 5)
    throw new QQKeyboardValidationError("QQ keyboard requires one to five rows")
  const ids = new Set<string>()
  return {
    content: {
      rows: rows.map((row) => {
        const buttons = object(row).buttons
        if (!Array.isArray(buttons) || !buttons.length || buttons.length > 5)
          throw new QQKeyboardValidationError("QQ keyboard requires one to five buttons per row")
        return {
          buttons: buttons.map((value): QQKeyboardButton => {
            const button = object(value)
            const id = text(button.id, 64)
            if (ids.has(id))
              throw new QQKeyboardValidationError("QQ keyboard button IDs must be unique")
            ids.add(id)
            const render = object(button.render_data)
            const action = object(button.action)
            const permission = object(action.permission)
            if (
              ![0, 1, 2].includes(action.type as number) ||
              ![0, 1, 2].includes(permission.type as number)
            )
              throw new QQKeyboardValidationError("QQ keyboard action or permission is invalid")
            const data = text(action.data, 4096)
            if (action.type === 0) {
              let url: URL
              try {
                url = new URL(data)
              } catch {
                throw new QQKeyboardValidationError("QQ link button URL is invalid")
              }
              if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
                throw new QQKeyboardValidationError(
                  "QQ link buttons require an HTTP(S) URL without credentials"
                )
            }
            if (
              action.enter !== undefined &&
              (typeof action.enter !== "boolean" ||
                action.type !== 2 ||
                (action.enter && scene !== "c2c"))
            )
              throw new QQKeyboardValidationError("QQ automatic command entry is C2C-only")
            if (
              action.reply !== undefined &&
              (typeof action.reply !== "boolean" || action.type !== 2)
            )
              throw new QQKeyboardValidationError("QQ command reply flag is invalid")
            if (
              action.anchor !== undefined &&
              (action.anchor !== 1 || action.type !== 2 || scene !== "c2c")
            )
              throw new QQKeyboardValidationError("QQ image-picker command is C2C-only")
            if (render.style !== undefined && ![0, 1, 3, 4].includes(render.style as number))
              throw new QQKeyboardValidationError("QQ keyboard style is invalid")
            let users: string[] | undefined
            if (permission.type === 0) {
              if (
                !Array.isArray(permission.specify_user_ids) ||
                !permission.specify_user_ids.length ||
                permission.specify_user_ids.length > 100
              )
                throw new QQKeyboardValidationError("QQ specified-user permission requires users")
              users = permission.specify_user_ids.map((id) => text(id, 256))
            }
            if (permission.specify_role_ids !== undefined || action.click_limit !== undefined)
              throw new QQKeyboardValidationError(
                "QQ keyboard field is not supported by this adapter"
              )
            return {
              id,
              ...(button.group_id !== undefined
                ? {
                    group_id:
                      action.type === 1
                        ? text(button.group_id, 64)
                        : (() => {
                            throw new QQKeyboardValidationError(
                              "QQ exclusive groups require callback buttons"
                            )
                          })(),
                  }
                : {}),
              render_data: {
                label: text(render.label, 10),
                ...(render.visited_label !== undefined
                  ? { visited_label: text(render.visited_label, 10) }
                  : {}),
                ...(render.style !== undefined ? { style: render.style as number } : {}),
              },
              action: {
                type: action.type as 0 | 1 | 2,
                data,
                permission: {
                  type: permission.type as 0 | 1 | 2,
                  ...(users ? { specify_user_ids: users } : {}),
                },
                ...(action.unsupport_tips !== undefined
                  ? { unsupport_tips: text(action.unsupport_tips, 100) }
                  : {}),
                ...(action.enter !== undefined ? { enter: action.enter as boolean } : {}),
                ...(action.reply !== undefined ? { reply: action.reply as boolean } : {}),
                ...(action.anchor === 1 ? { anchor: 1 as const } : {}),
                ...(action.modal !== undefined
                  ? {
                      modal: (() => {
                        const modal = object(action.modal)
                        const content = text(modal.content, 40)
                        if (/(?:https?:\/\/|www\.)/i.test(content))
                          throw new QQKeyboardValidationError(
                            "QQ confirmation text cannot contain URLs"
                          )
                        return {
                          content,
                          ...(modal.confirm_text !== undefined
                            ? { confirm_text: text(modal.confirm_text, 4) }
                            : {}),
                          ...(modal.cancel_text !== undefined
                            ? { cancel_text: text(modal.cancel_text, 4) }
                            : {}),
                        }
                      })(),
                    }
                  : {}),
              },
            }
          }),
        }
      }),
    },
  }
}
