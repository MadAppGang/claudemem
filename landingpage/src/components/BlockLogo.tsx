
import React, { useState, useMemo } from 'react';

// Precision 7-row pixel font grids based on the reference image
// Most letters are 4 blocks wide. 'M' is 5 blocks wide.
const LETTERS: Record<string, { w: number, grid: number[][] }> = {
  C: {
    w: 4,
    grid: [
      [1, 1, 1, 1],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 1, 1, 1],
    ]
  },
  L: {
    w: 4,
    grid: [
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 1, 1, 1],
    ]
  },
  A: {
    w: 4,
    grid: [
      [1, 1, 1, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 1, 1, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
    ]
  },
  U: {
    w: 4,
    grid: [
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 1, 1, 1],
    ]
  },
  D: {
    w: 4,
    grid: [
      [1, 1, 1, 0],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [1, 1, 1, 0],
    ]
  },
  E: {
    w: 4,
    grid: [
      [1, 1, 1, 1],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 1, 1, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 1, 1, 1],
    ]
  },
  M: {
    w: 5,
    grid: [
      [1, 0, 0, 0, 1],
      [1, 1, 0, 1, 1],
      [1, 0, 1, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 0, 0, 1],
    ]
  }
};

export const BlockLogo: React.FC = () => {
  return (
    <div className="inline-flex flex-col select-none items-center cursor-default">
      {/* 
         Logo Letters Container 
         Letters explode on hover.
      */}
      <div className="flex flex-nowrap gap-x-2 md:gap-x-4 items-end justify-center">
        {/* CLAUDE (Coral) */}
        {"CLAUDE".split('').map((char, i) => (
            <Letter key={`c-${i}`} char={char} color="#FF7E54" />
        ))}
        {/* MEM (Green) */}
        {"MEM".split('').map((char, i) => (
            <Letter key={`m-${i}`} char={char} color="#10F1B2" />
        ))}
      </div>
      
      {/* Tagline and Version Info Row */}
      <div className="w-full flex justify-between items-center mt-6 md:mt-8 px-0.5 text-gray-500 font-mono gap-4">
        <span className="text-[9px] md:text-[13px] tracking-widest font-medium uppercase opacity-80 whitespace-nowrap">
          Semantic code search powered by embeddings
        </span>
        <span className="text-[9px] md:text-[13px] tracking-widest font-bold opacity-70">
          v0.4.1
        </span>
      </div>
    </div>
  );
};

interface LetterProps {
  char: string;
  color: string;
}

const Letter: React.FC<LetterProps> = ({ char, color }) => {
  const [isHovered, setIsHovered] = useState(false);
  const data = LETTERS[char] || LETTERS['E'];
  const grid = data.grid;
  
  // Generate random trajectories for each pixel in the grid.
  // We use percentages relative to block size so it scales perfectly between mobile/desktop.
  // Range: +/- 2500% (approx 25 blocks distance) for a dramatic explosion.
  const particles = useMemo(() => {
    return grid.map((row) => 
      row.map(() => ({
        x: (Math.random() - 0.5) * 2500, // X scatter (percentage)
        y: (Math.random() - 0.5) * 2500, // Y scatter (percentage)
        r: (Math.random() - 0.5) * 180,  // Rotation (deg)
        d: Math.random() * 0.15,         // Delay (s) for stagger
        s: 0.6 + Math.random() * 0.4     // Scale noise
      }))
    );
  }, [char]);

  // Styles
  const blockSize = "w-[6px] h-[6px] md:w-[22px] md:h-[22px]"; 
  const gapSize = "gap-[1px] md:gap-[2px]";
  const offset1 = "top-[2px] left-[2px] md:top-[6px] md:left-[6px]";
  const offset2 = "top-[4px] left-[4px] md:top-[12px] md:left-[12px]";
  const outlineStyle = { borderColor: `${color}`, borderWidth: '1px' };

  // Helper to generate the dynamic style for a cell (voxel)
  // This applies the same transform to all layers of a single "pixel" so the 3D block stays cohesive while flying.
  const getDynamicStyle = (y: number, x: number) => {
      const p = particles[y][x];
      const baseTransition = `transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)`; // Springy pop effect
      
      if (isHovered) {
          return {
              transform: `translate(${p.x}%, ${p.y}%) rotate(${p.r}deg) scale(${p.s})`,
              transition: `${baseTransition} ${p.d}s`, // Add delay
          };
      }
      return {
          transform: 'translate(0, 0) rotate(0) scale(1)',
          // When returning, use a smoother ease and slight delay
          transition: `transform 0.5s cubic-bezier(0.25, 0.1, 0.25, 1) ${p.d * 0.5}s`, 
      };
  };

  return (
    <div 
        className={`relative ${isHovered ? 'z-50' : 'z-auto'}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
    >
      
      {/* Layer 3: Deepest Shadow */}
      <div className={`absolute ${offset2} flex flex-col ${gapSize} -z-20 pointer-events-none`} aria-hidden="true">
        {grid.map((row, y) => (
          <div key={`s3-${y}`} className={`flex ${gapSize}`}>
            {row.map((cell, x) => (
              <div 
                key={`s3-${y}-${x}`} 
                className={`${blockSize} ${cell ? 'border opacity-40' : 'bg-transparent'}`}
                style={{
                    ...(cell ? outlineStyle : {}),
                    ...(cell ? getDynamicStyle(y, x) : {})
                }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Layer 2: Middle Shadow */}
      <div className={`absolute ${offset1} flex flex-col ${gapSize} -z-10 pointer-events-none`} aria-hidden="true">
        {grid.map((row, y) => (
          <div key={`s2-${y}`} className={`flex ${gapSize}`}>
            {row.map((cell, x) => (
              <div 
                key={`s2-${y}-${x}`} 
                className={`${blockSize} ${cell ? 'border opacity-80' : 'bg-transparent'}`}
                style={{
                    ...(cell ? outlineStyle : {}),
                    ...(cell ? getDynamicStyle(y, x) : {})
                }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Layer 1: Front Face */}
      <div className={`flex flex-col ${gapSize} z-10 relative`}>
        {grid.map((row, y) => (
          <div key={`m-${y}`} className={`flex ${gapSize}`}>
            {row.map((cell, x) => (
              <div 
                key={`m-${y}-${x}`} 
                className={`${blockSize} transition-colors duration-300`}
                style={{
                    backgroundColor: cell ? color : 'transparent',
                    ...(cell ? getDynamicStyle(y, x) : {})
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
