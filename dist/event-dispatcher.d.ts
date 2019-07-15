
declare class EventDispatcher {
  /**
   * Adds an event listener
   */
  on(type: string, listener: Function): this;

  /**
   * Adds an event listener to be triggered only once
   */
  once(type: string, listener: Function): this;

  /**
   * Removes a previously added event listener
   */
  off(type: string, listener: Function): this;

  /**
   * Dispatches an event calling all listeners with the given args.
   */
  dispatchEvent(type: string, ...args: any[]): this;

  /**
   * Dispatches an event but stops on the first listener to return false. Returns true if no listeners cancel the
   * action. Use for "cancelable" actions to check if they can be performed.
   */
  dispatchCancelableEvent(type: string, ...args: any[]): boolean;

  /**
   * Remove all added events.
   */
  removeAllEvents(): void;
}

export default EventDispatcher;
