import { useEffect } from 'react';
import { useCADStore } from '../store/cadStore';

export function useCadShortcuts() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Prevent triggering shortcuts when the user is typing in an input field
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      // Retrieve stable actions and current state from the store directly
      const store = useCADStore.getState();
      const { setTool, clearSelection, toggleOsnap, undo, redo, removeEntity, toggleConstruction, selectedEntityIds } = store;

      const isMac = navigator.userAgent.toLowerCase().includes('mac');
      const isCmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;

      if (isCmdOrCtrl) {
        // Undo / Redo
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) {
            redo();
          } else {
            undo();
          }
        } else if (event.key.toLowerCase() === 'y') {
          event.preventDefault();
          redo();
        }
        return; // Don't process other single-key shortcuts if modifier is held
      }

      // We only want to trigger single-key shortcuts if NO modifier keys are pressed
      if (!event.altKey && !event.shiftKey) {
        switch (event.key.toLowerCase()) {
          case 'l':
            setTool('LINE');
            break;
          case 'd':
            setTool('DIMENSION');
            break;
          case 't':
            setTool('TRIM');
            break;
          case 'f':
            setTool('FILLET');
            break;
          case 's':
            setTool('SELECT');
            break;
          case 'r':
            setTool('RECTANGLE');
            break;
          case 'c':
            setTool('CIRCLE');
            break;
          case 'a':
            setTool('ARC_3P');
            break;
          case 'x':
            if (selectedEntityIds.length > 0) {
              event.preventDefault();
              selectedEntityIds.forEach((id) => toggleConstruction(id));
            }
            break;
          case 'escape':
            setTool('SELECT');
            clearSelection();
            break;
          case 'delete':
          case 'backspace':
            if (selectedEntityIds.length > 0) {
              event.preventDefault();
              selectedEntityIds.forEach((id) => removeEntity(id));
            }
            break;
          default:
            break;
        }

        // F3 (osnap) is uppercase/special, matching exact event.key
        if (event.key === 'F3') {
          event.preventDefault();
          toggleOsnap();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
}
