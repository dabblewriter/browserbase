type EventMap<T> = {
  [key in keyof T]: Event;
};

export class TypedEventTarget<T extends EventMap<T>> extends EventTarget {
  addEventListener<K extends keyof T>(
    type: K,
    listener: (this: this, ev: T[K]) => any,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof T>(
    type: K,
    listener: (this: this, ev: T[K]) => any,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void {
    super.removeEventListener(type, listener, options);
  }

  dispatchEvent<K extends keyof T>(event: T[K]): boolean;
  dispatchEvent(event: Event): boolean;
  dispatchEvent(event: Event): boolean {
    return super.dispatchEvent(event);
  }
}
