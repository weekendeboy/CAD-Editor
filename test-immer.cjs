const { createStore } = require('zustand/vanilla');
const { immer } = require('zustand/middleware/immer');

const store = createStore(
  immer((set) => ({
    count: 1,
    text: "hello",
    inc: () => set((state) => { 
        return { text: "replaced?" };
    })
  }))
);

store.getState().inc();
console.log("State:", store.getState());
