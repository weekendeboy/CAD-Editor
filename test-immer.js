const { create } = require('zustand');
const { immer } = require('zustand/middleware/immer');

const useStore = create(
  immer((set) => ({
    count: 1,
    text: "hello",
    inc: () => set((state) => { state.count++ }),
    setText: (text) => set({ text })
  }))
);

const state1 = useStore.getState();
useStore.getState().setText("world");
const state2 = useStore.getState();
console.log("State1:", state1);
console.log("State2:", state2);
