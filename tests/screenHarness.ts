import { act, createElement, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'

// Helpers for the jsdom screen tests. Everything rendered here is fictional.
export const browserDocument = Reflect.get(globalThis, 'document') as Document
const roots: Array<ReturnType<typeof createRoot>> = []

export async function mountScreen<P extends object>(component: ComponentType<P>, props: P): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => root.render(createElement(component as ComponentType<object>, props)))
  return element
}

export async function unmountScreens(): Promise<void> {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
}

export const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

// A button by its accessible name (aria-label first, then its text).
export const button = (root: Element, name: RegExp) => [...root.querySelectorAll('button')].find((candidate) => name.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''))
export const buttons = (root: Element, name: RegExp) => [...root.querySelectorAll('button')].filter((candidate) => name.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''))

export async function click(element: Element | undefined | null): Promise<void> {
  if (!element) throw new Error('Nothing to click.')
  await act(async () => (element as HTMLElement).click())
}

const valueSetter = (element: Element) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
export async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    valueSetter(element).call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
export async function choose(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    valueSetter(element).call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

// The form control a visible label names.
export function labelled<T extends HTMLElement = HTMLInputElement>(root: Element, text: string | RegExp): T {
  const label = [...root.querySelectorAll('label')].find((candidate) => (typeof text === 'string' ? candidate.textContent === text : text.test(candidate.textContent ?? '')))
  if (!label) throw new Error(`No label ${String(text)}`)
  const control = label.htmlFor ? browserDocument.getElementById(label.htmlFor) : label.querySelector('input,select,textarea')
  if (!control) throw new Error(`Label ${String(text)} controls nothing`)
  return control as T
}
