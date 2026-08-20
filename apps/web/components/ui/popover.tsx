'use client'

import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '@/lib/cn'

/**
 * A panel anchored to a trigger, rendered in a portal.
 *
 * The portal is the point. These panels used to be absolutely positioned
 * inside the row that opened them, and the file list is a Card with
 * `overflow-hidden` to clip its rounded corners — so the panel was cut off by
 * its own container and, on the last row, invisible entirely.
 *
 * Portalling also brings the things a hand-rolled dropdown never gets round
 * to: closing on Escape and on a click outside, flipping when there is no room
 * below, staying on screen near a window edge, and returning focus to the
 * trigger when it closes.
 */

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

export const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, align = 'end', sideOffset = 6, ...props }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        // Flip above the trigger when the panel would not fit below, and shift
        // sideways rather than hang off the edge of the window.
        avoidCollisions
        collisionPadding={12}
        className={cn(
          'z-50 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg',
          'outline-none',
          /*
           * Deliberately no max-height tied to the available space. Radix
           * decides which side to open on by whether the content fits, so
           * capping the height to what happens to be below the trigger makes
           * it always "fit" — and a panel on the last row of a list then
           * renders 60px tall and scrolling instead of simply flipping above.
           * Panels that can genuinely grow without bound scroll their own list.
           */
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
})
