import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

export type AdminTone = 'default' | 'primary' | 'danger' | 'success' | 'info'
export type AdminButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export const adminTheme = {
  surfaceLow: '#f3f3fe',
  surfaceLowest: '#ffffff',
  surfaceBright: '#faf8ff',
  outline: '#c3c6d7',
  onSurface: '#191b23',
  onSurfaceVariant: '#434655',
  primary: '#004ac6',
}

export function MaterialIcon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>
}

export function AdminButton({ variant = 'secondary', icon, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: AdminButtonVariant; icon?: string }) {
  const variants: Record<AdminButtonVariant, string> = {
    primary: 'bg-[#191b23] text-white hover:opacity-90 disabled:opacity-60',
    secondary: 'border border-[#c3c6d7] bg-white text-[#434655] hover:bg-[#faf8ff] disabled:opacity-60',
    ghost: 'text-[#434655] hover:text-[#191b23] disabled:opacity-60',
    danger: 'bg-[#ba1a1a] text-white hover:bg-[#93000a] disabled:opacity-60',
  }
  return <button {...props} className={`inline-flex h-[42px] items-center justify-center gap-2 rounded px-6 py-2 text-sm font-medium transition-colors ${variants[variant]} ${className}`}>
    {icon && <MaterialIcon name={icon} className="text-[18px]" />}
    {children}
  </button>
}

export function AdminTextButton({ tone = 'primary', className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: AdminTone }) {
  const tones: Record<AdminTone, string> = {
    default: 'text-[#434655] hover:text-[#191b23]',
    primary: 'text-[#004ac6] hover:opacity-80',
    danger: 'text-[#ba1a1a] hover:opacity-80',
    success: 'text-emerald-700 hover:opacity-80',
    info: 'text-[#004ac6] hover:opacity-80',
  }
  return <button {...props} className={`text-xs font-semibold transition ${tones[tone]} ${className}`}>{children}</button>
}

export function AdminInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`h-[42px] w-full rounded border border-[#c3c6d7] bg-[#f3f3fe] px-4 py-2 text-sm text-[#191b23] outline-none transition-colors placeholder:text-[#737686] focus:border-[#191b23] focus:ring-1 focus:ring-[#191b23] ${className}`} />
}

export function AdminCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-[#c3c6d7] bg-white ${className}`}>{children}</section>
}

export function AdminTag({ tone = 'default', children, className = '' }: { tone?: AdminTone; children: ReactNode; className?: string }) {
  const tones: Record<AdminTone, string> = {
    default: 'border-[#c3c6d7] bg-[#ededf9] text-[#434655]',
    primary: 'border-[#b4c5ff] bg-[#dbe1ff] text-[#00174b]',
    danger: 'border-red-200 bg-red-50 text-red-700',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    info: 'border-[#c3c6d7] bg-[#ededf9] text-[#191b23]',
  }
  return <span className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${tones[tone]} ${className}`}>{children}</span>
}

export function AdminNotice({ type, children }: { type: 'success' | 'error'; children: ReactNode }) {
  const isError = type === 'error'
  return <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${isError ? 'border-[#ba1a1a]/20 bg-[#ffdad6] text-[#93000a]' : 'border-[#c3c6d7]/50 bg-[#ededf9] text-[#191b23]'}`}>
    <MaterialIcon name={isError ? 'error' : 'check_circle'} className={`mt-0.5 text-[20px] ${isError ? '' : 'text-[#004ac6]'}`} />
    <p className="text-sm font-medium leading-[1.5]">{children}</p>
  </div>
}

export function AdminToast({ type, text, onClose }: { type: 'success' | 'error'; text: string; onClose: () => void }) {
  const isError = type === 'error'
  return <div className={`fixed right-6 top-6 z-[120] flex max-w-[420px] items-start gap-3 rounded-xl border px-4 py-3 shadow-[0_12px_32px_rgba(0,0,0,0.12)] ${isError ? 'border-[#ba1a1a]/20 bg-[#ffdad6] text-[#93000a]' : 'border-[#c3c6d7] bg-white text-[#191b23]'}`}>
    <MaterialIcon name={isError ? 'error' : 'check_circle'} className={`mt-0.5 text-[20px] ${isError ? '' : 'text-[#004ac6]'}`} />
    <p className="min-w-0 flex-1 text-sm font-medium leading-[1.5]">{text}</p>
    <button type="button" onClick={onClose} className="text-lg leading-none opacity-60 hover:opacity-100">×</button>
  </div>
}

export function AdminModal({ title, description, children, footer, onClose, zIndex = 'z-[80]', maxWidth = 'max-w-[480px]' }: { title: string; description?: string; children?: ReactNode; footer: ReactNode; onClose: () => void; zIndex?: string; maxWidth?: string }) {
  return <div className={`fixed inset-0 ${zIndex} flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-sm`} onMouseDown={onClose}>
    <div onMouseDown={(e) => e.stopPropagation()} className={`flex w-full ${maxWidth} flex-col overflow-hidden rounded-xl border border-[#c3c6d7] bg-white shadow-[0_4px_24px_rgba(0,0,0,0.08)]`}>
      <div className="border-b border-[#c3c6d7]/30 p-6 pb-4">
        <h3 className="mb-2 text-2xl font-semibold leading-[1.3] tracking-[-0.01em] text-[#191b23]">{title}</h3>
        {description && <p className="text-sm leading-[1.6] text-[#434655]">{description}</p>}
      </div>
      {children && <div className="space-y-4 p-6">{children}</div>}
      <div className="flex justify-end gap-3 border-t border-[#c3c6d7]/30 bg-[#faf8ff] p-6 pt-4">{footer}</div>
    </div>
  </div>
}
